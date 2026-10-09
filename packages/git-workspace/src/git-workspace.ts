import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type {
  AnalysisWorkspace,
  GitWorkspacePort,
  PublishedBranch,
  RunRequest,
  Snapshot,
  WorkspaceReference,
} from "@factory/core";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export interface GitWorkspaceOptions {
  readonly workspaceRoot?: string;
  readonly commandTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitCommandError";
  }
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Owns an independent local clone and atomically publishes one new source branch.
 * Failed or unpublished workspaces are intentionally retained for diagnosis.
 */
export class GitWorkspace implements GitWorkspacePort {
  readonly #workspaceRoot: string;
  readonly #commandTimeoutMs: number;
  readonly #signal: AbortSignal | undefined;

  #workspace: WorkspaceReference | undefined;
  #sourcePath: string | undefined;
  #sourceBaseRef: string | undefined;
  readonly #analysisPaths = new Set<string>();
  readonly #analysisDigests = new Map<string, string>();
  readonly #snapshotManifests = new Map<string, ReadonlyMap<string, string>>();
  #published = false;

  constructor(options: GitWorkspaceOptions = {}) {
    this.#workspaceRoot = options.workspaceRoot ?? tmpdir();
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.#signal = options.signal;
  }

  async prepare(request: RunRequest): Promise<WorkspaceReference> {
    if (this.#workspace !== undefined) {
      throw new Error("Git workspace has already been prepared");
    }

    const sourcePath = await realpath(request.repository.sourcePath);
    const branch = request.repository.outputBranch;
    await this.#git(sourcePath, ["check-ref-format", "--branch", branch], "validate output branch");

    const baseCommit = (await this.#git(
      sourcePath,
      ["rev-parse", "--verify", "--end-of-options", `${request.repository.baseRef}^{commit}`],
      "resolve source base ref",
    )).stdout.trim();
    const sourceBaseRef = await this.#resolveSourceRef(sourcePath, request.repository.baseRef, baseCommit);

    await mkdir(this.#workspaceRoot, { recursive: true });
    const runPrefix = request.runId.replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "run";
    const diagnosticRoot = await mkdtemp(join(this.#workspaceRoot, `${runPrefix}-`));
    const workspacePath = join(diagnosticRoot, "repository");

    await this.#git(this.#workspaceRoot, [
      "clone",
      "--no-local",
      "--no-hardlinks",
      "--no-checkout",
      "--",
      sourcePath,
      workspacePath,
    ], "create isolated clone");
    await this.#git(workspacePath, ["remote", "remove", "origin"], "remove source remote");
    await this.#git(workspacePath, ["switch", "--create", branch, baseCommit], "create designated branch");

    const workspace = { path: workspacePath, baseCommit, branch };
    this.#workspace = workspace;
    this.#sourcePath = sourcePath;
    this.#sourceBaseRef = sourceBaseRef;
    return workspace;
  }

  async snapshot(label: string): Promise<Snapshot> {
    const workspace = this.#requireWorkspace();
    const manifest = new Map<string, string>();
    const id = await digestPublishableFiles(workspace.path, await this.#publishableFiles(workspace.path), manifest);
    this.#snapshotManifests.set(id, manifest);
    const commit = (await this.#git(
      workspace.path,
      ["rev-parse", "--verify", "HEAD"],
      `resolve snapshot commit '${label}'`,
    )).stdout.trim();
    return { id, commit };
  }

  async createAnalysisWorkspace(expectedTreeId: string): Promise<AnalysisWorkspace> {
    const workspace = this.#requireWorkspace();
    await assertNoNestedGitMetadata(workspace.path, workspace.path);
    const publishableFiles = await this.#publishableFiles(workspace.path);
    const treeId = await digestPublishableFiles(workspace.path, publishableFiles);
    if (treeId !== expectedTreeId) {
      throw new Error(`Cannot create analysis workspace: expected tree ${expectedTreeId}, found ${treeId}`);
    }

    const analysisPath = await mkdtemp(join(workspace.path, "..", "pull-request-analysis-"));
    try {
      await this.#git(join(workspace.path, ".."), [
        "clone",
        "--no-local",
        "--no-hardlinks",
        "--no-checkout",
        "--",
        this.#sourcePath!,
        analysisPath,
      ], "create pull-request analysis clone");
      await this.#git(analysisPath, ["remote", "remove", "origin"], "remove analysis source remote");
      await this.#git(analysisPath, ["switch", "--detach", workspace.baseCommit], "checkout analysis base");
      await copyPublishableTree(workspace.path, analysisPath, publishableFiles);
      const copiedFiles = await this.#publishableFiles(analysisPath);
      const copiedTreeId = await digestPublishableFiles(analysisPath, copiedFiles);
      if (copiedTreeId !== expectedTreeId) {
        throw new Error("Analysis copy differs from the verified candidate tree");
      }
      const inputDigest = await digestCompleteTree(analysisPath);
      await makeDirectoryTreeReadOnly(analysisPath);
      this.#analysisPaths.add(analysisPath);
      this.#analysisDigests.set(analysisPath, inputDigest);
      return { path: analysisPath, treeId: copiedTreeId };
    } catch (error) {
      await makeDirectoryTreeRemovable(analysisPath);
      await rm(analysisPath, { recursive: true, force: true });
      throw error;
    }
  }

  async createChangePackage(fromTreeId: string, toTreeId: string): Promise<string> {
    const from = this.#snapshotManifests.get(fromTreeId);
    const to = this.#snapshotManifests.get(toTreeId);
    if (from === undefined) throw new Error(`Unknown change-package baseline tree ${fromTreeId}`);
    if (to === undefined) throw new Error(`Unknown change-package candidate tree ${toTreeId}`);
    const added = [...to.keys()].filter((path) => !from.has(path)).sort();
    const modified = [...to.keys()].filter((path) => from.has(path) && from.get(path) !== to.get(path)).sort();
    const deleted = [...from.keys()].filter((path) => !to.has(path)).sort();
    return `${JSON.stringify({
      schemaVersion: 1,
      fromTreeId,
      toTreeId,
      added,
      modified,
      deleted,
      files: [...to].map(([path, sha256]) => ({ path, sha256 })),
    }, null, 2)}\n`;
  }

  async verifyAnalysisWorkspace(workspace: AnalysisWorkspace): Promise<void> {
    const expectedDigest = this.#analysisDigests.get(workspace.path);
    if (expectedDigest === undefined || !this.#analysisPaths.has(workspace.path)) {
      throw new Error(`Unknown analysis workspace: ${workspace.path}`);
    }
    const actualDigest = await digestCompleteTree(workspace.path);
    if (actualDigest !== expectedDigest) {
      throw new Error(`Read-only analysis input was modified: expected ${expectedDigest}, found ${actualDigest}`);
    }
  }

  async disposeAnalysisWorkspace(workspace: AnalysisWorkspace): Promise<void> {
    if (!this.#analysisPaths.delete(workspace.path)) {
      throw new Error(`Unknown pull-request analysis workspace: ${workspace.path}`);
    }
    this.#analysisDigests.delete(workspace.path);
    await makeDirectoryTreeRemovable(workspace.path);
    await rm(workspace.path, { recursive: true, force: true });
  }

  async publishBranch(expectedBaseCommit: string): Promise<PublishedBranch> {
    const workspace = this.#requireWorkspace();
    const sourcePath = this.#sourcePath!;
    if (expectedBaseCommit !== workspace.baseCommit) {
      throw new Error(`Cannot publish: expected base commit does not match recorded base commit ${workspace.baseCommit}`);
    }

    await this.#verifySourceBase("before publication");
    const currentBranch = (await this.#git(
      workspace.path,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      "verify designated workspace branch",
    )).stdout.trim();
    if (currentBranch !== workspace.branch) {
      throw new Error(`Cannot publish: workspace is on '${currentBranch}', not designated branch '${workspace.branch}'`);
    }

    const outputRef = `refs/heads/${workspace.branch}`;
    const collision = await this.#gitAllowExitCode(
      sourcePath,
      ["show-ref", "--verify", "--quiet", outputRef],
      "check output branch collision",
      1,
    );
    if (collision.exitCode === 0) {
      throw new Error(`Cannot publish: output branch '${workspace.branch}' already exists`);
    }

    const publicationPath = join(workspace.path, "..", "trusted-publication");
    await rm(publicationPath, { recursive: true, force: true });
    await this.#git(join(workspace.path, ".."), [
      "clone",
      "--no-local",
      "--no-hardlinks",
      "--no-checkout",
      "--",
      sourcePath,
      publicationPath,
    ], "create trusted publication clone");
    await this.#git(publicationPath, ["remote", "remove", "origin"], "remove publication source remote");
    await this.#git(publicationPath, ["switch", "--detach", workspace.baseCommit], "checkout trusted base");
    await assertNoNestedGitMetadata(workspace.path, workspace.path);
    const publishableFiles = await this.#publishableFiles(workspace.path);
    const verifiedTreeIdentity = await digestPublishableFiles(workspace.path, publishableFiles);
    await copyPublishableTree(workspace.path, publicationPath, publishableFiles);
    await this.#git(publicationPath, ["add", "--all"], "stage trusted final tree");
    const staged = await this.#gitAllowExitCode(
      publicationPath,
      ["diff", "--cached", "--quiet", "--exit-code"],
      "inspect trusted final tree",
      1,
    );
    if (staged.exitCode === 1) {
      await this.#git(publicationPath, [
        "-c", "user.name=Local Software Factory",
        "-c", "user.email=local-software-factory@invalid",
        "commit", "--no-gpg-sign", "-m", "Factory: capture verified workspace tree",
      ], "commit trusted final tree");
    }

    const finalCommit = (await this.#git(publicationPath, ["rev-parse", "--verify", "HEAD^{commit}"], "resolve final commit")).stdout.trim();
    const materializedPath = join(workspace.path, "..", "trusted-materialization");
    await rm(materializedPath, { recursive: true, force: true });
    await this.#git(join(workspace.path, ".."), [
      "clone",
      "--no-local",
      "--no-hardlinks",
      "--no-checkout",
      "--",
      publicationPath,
      materializedPath,
    ], "materialize trusted final commit");
    await this.#git(materializedPath, ["switch", "--detach", finalCommit], "checkout trusted final commit");
    const committedTreeIdentity = await digestPublishableFiles(materializedPath, publishableFiles);
    if (committedTreeIdentity !== verifiedTreeIdentity) {
      throw new Error("Cannot publish: committed content differs from the verified workspace tree");
    }
    await this.#git(publicationPath, ["merge-base", "--is-ancestor", workspace.baseCommit, finalCommit], "verify final commit descends from base");
    const mergeCommits = (await this.#git(
      publicationPath,
      ["rev-list", "--min-parents=2", `${workspace.baseCommit}..${finalCommit}`],
      "verify branch contains no merges",
    )).stdout.trim();
    if (mergeCommits !== "") {
      throw new Error(`Cannot publish: designated branch contains merge commit ${mergeCommits.split("\n")[0]}`);
    }

    await this.#git(sourcePath, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--",
      publicationPath,
      finalCommit,
    ], "transfer final commit to source repository");

    const transaction = ["start"];
    if (this.#sourceBaseRef !== undefined) {
      transaction.push(`verify ${this.#sourceBaseRef} ${workspace.baseCommit}`);
    }
    transaction.push(`create ${outputRef} ${finalCommit}`, "prepare", "commit", "");
    try {
      await this.#git(sourcePath, ["update-ref", "--stdin"], "publish designated output branch", undefined, transaction.join("\n"));
    } catch (error) {
      const nowExists = await this.#gitAllowExitCode(
        sourcePath,
        ["show-ref", "--verify", "--quiet", outputRef],
        "confirm output branch collision",
        1,
      );
      if (nowExists.exitCode === 0) {
        throw new Error(`Cannot publish: output branch '${workspace.branch}' already exists`, { cause: error });
      }
      throw error;
    }

    await this.#verifySourceBase("after publication");
    this.#published = true;
    return { branch: workspace.branch, commit: finalCommit };
  }

  async disposeExecutionResources(): Promise<void> {
    for (const path of this.#analysisPaths) {
      await makeDirectoryTreeRemovable(path);
      await rm(path, { recursive: true, force: true });
      this.#analysisPaths.delete(path);
      this.#analysisDigests.delete(path);
    }
    if (this.#published && this.#workspace !== undefined) {
      const executionRoot = join(this.#workspace.path, "..");
      await makeDirectoryTreeRemovable(executionRoot);
      await rm(executionRoot, { recursive: true, force: true });
      this.#workspace = undefined;
    }
  }

  #requireWorkspace(): WorkspaceReference {
    if (this.#workspace === undefined) {
      throw new Error("Git workspace has not been prepared");
    }
    return this.#workspace;
  }

  async #resolveSourceRef(sourcePath: string, baseRef: string, baseCommit: string): Promise<string | undefined> {
    const symbolic = await this.#gitAllowExitCode(
      sourcePath,
      ["rev-parse", "--verify", "--symbolic-full-name", "--end-of-options", baseRef],
      "identify source base ref",
      1,
    );
    const ref = symbolic.stdout.trim();
    if (symbolic.exitCode !== 0 || !ref.startsWith("refs/")) {
      return undefined;
    }
    const refCommit = (await this.#git(sourcePath, ["rev-parse", "--verify", `${ref}^{commit}`], "record source base ref")).stdout.trim();
    return refCommit === baseCommit ? ref : undefined;
  }

  async #verifySourceBase(phase: string): Promise<void> {
    const workspace = this.#requireWorkspace();
    if (this.#sourceBaseRef === undefined) {
      return;
    }
    const current = (await this.#git(
      this.#sourcePath!,
      ["rev-parse", "--verify", `${this.#sourceBaseRef}^{commit}`],
      `verify source base ref ${phase}`,
    )).stdout.trim();
    if (current !== workspace.baseCommit) {
      throw new Error(`Cannot publish: source base ref '${this.#sourceBaseRef}' changed ${phase}`);
    }
  }

  async #publishableFiles(root: string): Promise<readonly string[]> {
    const output = (await this.#git(
      root,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      "enumerate publishable files",
    )).stdout;
    const files: string[] = [];
    const seen = new Set<string>();
    for (const path of output.split("\0")) {
      if (path.length === 0 || path === ".sandcastle" || path.startsWith(".sandcastle/")) continue;
      assertSafeRelativePath(root, path);
      if (seen.has(path)) throw new Error(`Cannot publish duplicate path ${path}`);
      seen.add(path);
      try {
        const entry = await lstat(resolve(root, path));
        if (!entry.isFile() && !entry.isSymbolicLink()) {
          throw new Error(`Cannot publish unsupported filesystem entry ${path}`);
        }
        files.push(path);
      } catch (error) {
        if (isMissingPath(error)) continue;
        throw error;
      }
    }
    files.sort();
    return files;
  }

  async #git(
    cwd: string,
    args: readonly string[],
    operation: string,
    environment?: Readonly<Record<string, string>>,
    stdin?: string,
  ): Promise<CommandResult> {
    return this.#runGit(cwd, args, operation, environment, stdin, []);
  }

  async #gitAllowExitCode(
    cwd: string,
    args: readonly string[],
    operation: string,
    allowedExitCode: number,
  ): Promise<CommandResult> {
    return this.#runGit(cwd, args, operation, undefined, undefined, [allowedExitCode]);
  }

  async #runGit(
    cwd: string,
    args: readonly string[],
    operation: string,
    environment: Readonly<Record<string, string>> | undefined,
    stdin: string | undefined,
    allowedExitCodes: readonly number[],
  ): Promise<CommandResult> {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        HOME: tmpdir(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...environment,
      },
      signal: this.#signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, this.#commandTimeoutMs);

    const collect = (chunk: Buffer, target: "stdout" | "stderr"): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    const closeEvent = once(child, "close");
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin, "utf8");

    let code: number | null;
    try {
      [code] = await closeEvent as [number | null, NodeJS.Signals | null];
    } catch (error) {
      clearTimeout(timer);
      const detail = error instanceof Error ? error.message : String(error);
      throw new GitCommandError(`Unable to ${operation}: ${detail}`, undefined, { cause: error });
    }
    clearTimeout(timer);
    if (timedOut) {
      throw new GitCommandError(`Unable to ${operation}: git command exceeded ${this.#commandTimeoutMs}ms`);
    }
    if (outputExceeded) {
      throw new GitCommandError(`Unable to ${operation}: git command output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`);
    }
    const exitCode = code ?? -1;
    const result = { stdout, stderr, exitCode };
    if (exitCode === 0 || allowedExitCodes.includes(exitCode)) {
      return result;
    }
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new GitCommandError(`Unable to ${operation}: ${detail}`, exitCode);
  }
}

async function copyPublishableTree(
  source: string,
  destination: string,
  files: readonly string[],
): Promise<void> {
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    if (entry.name !== ".git") {
      await rm(join(destination, entry.name), { recursive: true, force: true });
    }
  }
  for (const path of files) {
    const sourcePath = resolve(source, path);
    const destinationPath = resolve(destination, path);
    await mkdir(dirname(destinationPath), { recursive: true });
    const entry = await lstat(sourcePath);
    if (entry.isSymbolicLink()) {
      await symlink(await readlink(sourcePath), destinationPath);
    } else {
      await copyFile(sourcePath, destinationPath);
    }
  }
}

async function assertNoNestedGitMetadata(root: string, directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory !== root && entry.name === ".git") {
      throw new Error(`Cannot publish nested Git metadata at ${relative(root, join(directory, entry.name))}`);
    }
    if (entry.name === ".git" && directory === root) continue;
    if (entry.isDirectory()) await assertNoNestedGitMetadata(root, join(directory, entry.name));
  }
}

async function digestPublishableFiles(
  root: string,
  files: readonly string[],
  manifest?: Map<string, string>,
): Promise<string> {
  const digest = createHash("sha256");
  for (const name of files) {
    const path = resolve(root, name);
    const metadata = await lstat(path);
    const content = metadata.isSymbolicLink() ? `link:${await readlink(path)}` : await readFile(path);
    digest.update(name.split(sep).join("/"));
    digest.update("\0");
    digest.update(content);
    digest.update("\n");
    if (manifest !== undefined) {
      manifest.set(name.split(sep).join("/"), createHash("sha256").update(content).digest("hex"));
    }
  }
  return digest.digest("hex");
}

function assertSafeRelativePath(root: string, path: string): void {
  if (isAbsolute(path)) throw new Error(`Cannot publish absolute path ${path}`);
  const resolved = resolve(root, path);
  const relation = relative(root, resolved);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Cannot publish path outside the workspace: ${path}`);
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function makeDirectoryTreeRemovable(root: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(root);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) return;
  await chmod(root, 0o755);
  for (const child of await readdir(root)) {
    await makeDirectoryTreeRemovable(join(root, child));
  }
}

async function makeDirectoryTreeReadOnly(root: string): Promise<void> {
  const entry = await lstat(root);
  if (entry.isSymbolicLink()) return;
  if (!entry.isDirectory()) {
    await chmod(root, 0o444);
    return;
  }
  for (const child of await readdir(root)) {
    await makeDirectoryTreeReadOnly(join(root, child));
  }
  await chmod(root, 0o555);
}

async function digestCompleteTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    const children = (await readdir(directory)).sort();
    for (const child of children) {
      const path = join(directory, child);
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) {
        hash.update(`L\\0${relativePath}\\0${await readlink(path)}\\0`);
      } else if (entry.isDirectory()) {
        hash.update(`D\\0${relativePath}\\0`);
        await visit(path);
      } else if (entry.isFile()) {
        hash.update(`F\\0${relativePath}\\0${entry.size}\\0`);
        hash.update(await readFile(path));
        hash.update("\\0");
      } else {
        throw new Error(`Analysis workspace contains unsupported entry ${relativePath}`);
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}
