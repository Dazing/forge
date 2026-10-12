import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

// Structured subprocess client for Git and other argv commands, split from main.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

const execFile = promisify(execFileCallback);

/** Immutable, sanitized fields describing a failed external command, sufficient for ticket diagnostics. */
export type CommandFailure = Readonly<{
  operation: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

/** Command failure that preserves the exec cause plus exit code, stdout, and stderr for ticket diagnostics. */
export class CommandFailedError extends Error {
  constructor(
    readonly failure: CommandFailure,
    cause: unknown,
  ) {
    super(`Command failed while ${failure.operation}: ${failure.command} exited ${failure.exitCode}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "CommandFailedError";
  }
}

/** Run argv directly (never a shell string) and return stdout; failures keep exit code, stdout, and stderr. */
export async function runCommand(
  command: string,
  args: readonly string[],
  operation: string,
  cwd?: string,
): Promise<string> {
  const displayCommand = [command, ...args].join(" ");
  try {
    const result = cwd === undefined ? await execFile(command, args) : await execFile(command, args, { cwd });
    return result.stdout;
  } catch (error) {
    const fields = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    throw new CommandFailedError(
      {
        operation,
        command: displayCommand,
        exitCode: typeof fields.code === "number" ? fields.code : -1,
        stdout: typeof fields.stdout === "string" ? fields.stdout : "",
        stderr: typeof fields.stderr === "string" ? fields.stderr : "",
      },
      error,
    );
  }
}

/** Run one git command in a repository and return its stdout. */
export async function runGit(repo: string, args: readonly string[], operation: string): Promise<string> {
  return runCommand("git", ["-C", repo, ...args], operation);
}

/** Run Git with the command-local identity used for every runner-owned commit. */
export async function runGitAsRunner(repo: string, args: readonly string[], operation: string): Promise<string> {
  return runGit(repo, ["-c", "user.name=Factory Runner", "-c", "user.email=factory-runner@localhost", ...args], operation);
}

/** Require a clean index and worktree, including untracked files, before advancing a stage. */
export async function requireCleanRepository(repository: string, stage: string): Promise<void> {
  const status = (await runGit(repository, ["status", "--porcelain"], "inspecting branch worktree")).trim();
  if (status.length === 0) return;

  throw new Error(`${stage} left uncommitted changes in the branch worktree: ${status.replaceAll("\n", ", ")}`);
}

/** Porcelain status codes for index entries with unresolved merge conflicts. */
const unmergedStatusCodes = new Set(["AA", "AU", "DD", "DU", "UD", "UU"]);

/** Require no unresolved merge conflicts in a repository index, so a checkpoint never records conflicted content. */
export async function requireNoUnmergedEntries(repository: string, stage: string): Promise<void> {
  const status = await runGit(repository, ["status", "--porcelain"], "inspecting branch worktree");
  const conflicts = status.split("\n").filter((line) => line.length > 0 && unmergedStatusCodes.has(line.slice(0, 2)));
  if (conflicts.length === 0) return;

  throw new Error(`${stage} found unresolved merge conflicts in the branch worktree: ${conflicts.join(", ")}.`);
}

/** Normalize any stage failure to the structured command-failure shape used for ticket and log diagnostics. */
export function toCommandFailure(error: unknown, stage: string): CommandFailure {
  if (error instanceof CommandFailedError) return error.failure;
  return {
    operation: stage,
    command: `runner ${stage} stage`,
    exitCode: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  };
}

/** Immutable HEAD/status pair for snapshot comparison across a stage. */
export type RepositorySnapshot = Readonly<{
  head: string;
  status: string;
}>;

/** Snapshot a repository's HEAD commit and porcelain worktree status. */
export async function snapshotRepository(repository: string): Promise<RepositorySnapshot> {
  const head = (await runGit(repository, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();
  const status = (await runGit(repository, ["status", "--porcelain"], "reading worktree status")).trim();
  return { head, status };
}

/** Require HEAD and porcelain status to be unchanged across a stage, naming the stage and label in the failure. */
export function requireUnchanged(stage: string, label: string, before: RepositorySnapshot, after: RepositorySnapshot): void {
  if (after.head !== before.head) {
    throw new Error(`${stage} changed ${label} commits: ${before.head} -> ${after.head}.`);
  }
  if (after.status !== before.status) {
    throw new Error(`${stage} changed ${label} worktree status.`);
  }
}

/** Read the symbolic branch checked out in a repository; detached HEAD reports `HEAD`. */
export async function currentBranch(repository: string): Promise<string> {
  return (await runGit(repository, ["rev-parse", "--abbrev-ref", "HEAD"], "reading HEAD branch")).trim();
}

/** Immutable HEAD commit and symbolic branch pair for stage-boundary comparison; worktree status is deliberately excluded. */
export type HeadAndBranch = Readonly<{
  head: string;
  branch: string;
}>;

/** Snapshot a repository's HEAD commit and symbolic branch. */
export async function snapshotHeadAndBranch(repository: string): Promise<HeadAndBranch> {
  const head = (await runGit(repository, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();
  return { head, branch: await currentBranch(repository) };
}
