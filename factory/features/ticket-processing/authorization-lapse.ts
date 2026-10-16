import { requireCleanRepository, runGit, runGitAsRunner, snapshotHeadAndBranch } from "../../infrastructure/git-provider/git.js";
import { redactSecrets } from "../../shared/redact-secret.js";

// An authorization lapse is a credential/permission failure, not a work failure: retrying it burns
// attempts and never succeeds, and the commits already made must survive. Recognition is text-based
// because Git and both providers report these conditions only through stderr and HTTP bodies.

/** Where the missing authority was reported. */
export type LapseSource = "github" | "azure-devops" | "git";

export type AuthorizationLapse = Readonly<{
  source: LapseSource;
  /** The first matching report, redacted and length-bounded, safe to publish as an issue fact. */
  detail: string;
}>;

type Pattern = Readonly<{ source: LapseSource; test: RegExp }>;

const PATTERNS: readonly Pattern[] = [
  { source: "github", test: /resource not accessible by (personal access token|integration|installation)/i },
  { source: "github", test: /bad credentials/i },
  { source: "github", test: /must have admin rights/i },
  { source: "github", test: /insufficient.*scope|required scope|scope[s]? .*insufficient/i },
  { source: "github", test: /protected branch.*not have permission|not have permission to.*protected branch/i },
  { source: "github", test: /saml (enforcement|authorization)/i },
  { source: "github", test: /ghp_[A-Za-z0-9]+.*(expired|revoked)|token has been (revoked|disabled)|token.*expired/i },
  { source: "github", test: /\b403\b.{0,80}(forbidden|resource|permission)|permission.{0,80}\b403\b/i },
  { source: "github", test: /github.{0,40}\b401\b|\b401\b.{0,40}(unauthorized|github)/i },
  { source: "azure-devops", test: /\btf401027\b|\btf400813\b|\btf401019\b|\btf401344\b/i },
  { source: "azure-devops", test: /vso\.(code_write|code_read|agent_contribute|pullrequests_write|graph_member_read|project_and_team_read)/i },
  { source: "azure-devops", test: /azure devops (oauth )?token (has expired|lacks|is not valid)|az10007/i },
  { source: "azure-devops", test: /(user|token).{0,60}(not authorized|does not have (permission|access))|needs? the .* permission/i },
  { source: "azure-devops", test: /azure devops.{0,60}\b40[13]\b|\b40[13]\b.{0,60}azure devops/i },
  { source: "git", test: /permission denied \(publickey\)/i },
  { source: "git", test: /permission denied, please try again/i },
  { source: "git", test: /could not read username for|terminal prompts disabled|no askpass program/i },
  { source: "git", test: /authentication failed|invalid credentials|authentication required/i },
  { source: "git", test: /repository (was )?not found|project .* does not exist|remote repository does not exist/i },
  { source: "git", test: /the requested url returned error: 40[13]/i },
];

/** Classify one failure report as an authorization lapse, redacting every known credential first. */
export function detectAuthorizationLapse(report: string, secrets: readonly string[] = []): AuthorizationLapse | undefined {
  const text = redactSecrets(secrets, report);
  for (const pattern of PATTERNS) {
    const match = pattern.test.exec(text);
    if (match === null) continue;
    return { source: pattern.source, detail: boundedDetail(text, match.index) };
  }
  return undefined;
}

/** One redacted line around the match, so the published fact names the lapse without dumping a transcript. */
function boundedDetail(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
  return line.length > 240 ? `${line.slice(0, 240)}...` : line;
}


/** Work the runner kept when authorization lapsed: pushed branch when the push itself is still authorized, plus the retained workspace. */
export type PreservedAttempt = Readonly<{
  attemptId: string;
  branch: string;
  repository: string;
  baseBranch: string;
  workspacePath: string;
  commitSha: string;
  pushed: boolean;
  pushFailure: string | undefined;
  captureComplete: boolean;
  captureFailure: string | undefined;
}>;

/** Capture unfinished work in a distinct runner commit, then push non-force without publishing a pull request. */
export async function preserveAttemptWorkspace(input: Readonly<{
  attemptId: string;
  branch: string;
  repository: string;
  baseBranch: string;
  workspacePath: string;
  secrets: readonly string[];
}>): Promise<PreservedAttempt> {
  const entry = await snapshotHeadAndBranch(input.workspacePath);
  const facts = {
    attemptId: input.attemptId,
    branch: input.branch,
    repository: input.repository,
    baseBranch: input.baseBranch,
    workspacePath: input.workspacePath,
  };
  let commitSha = entry.head;
  let captureComplete = false;
  let captureFailure: string | undefined;
  const diagnostic = (error: unknown): string => redactSecrets(input.secrets, error instanceof Error ? error.message : String(error)).slice(0, 240);
  const validatedBlobs = new Set<string>();
  const validateSecrets = async (tree: string, message: string): Promise<void> => {
    const secrets = input.secrets.filter((secret) => secret.length > 0);
    if (secrets.length === 0) return;
    if (secrets.some((secret) => message.includes(secret))) throw new Error("Preservation message contains credential material.");
    const entries = await runGit(input.workspacePath, ["ls-tree", "-r", "-z", tree], "inspecting preservation tree");
    for (const entry of entries.split("\0")) {
      if (entry.length === 0) continue;
      if (secrets.some((secret) => entry.includes(secret))) throw new Error("Preservation path contains credential material.");
      const [metadata] = entry.split("\t");
      const [, kind, object] = metadata!.split(" ");
      if (kind !== "blob" || object === undefined || validatedBlobs.has(object)) continue;
      const content = await runGit(input.workspacePath, ["cat-file", "blob", object], "validating preservation content");
      if (secrets.some((secret) => content.includes(secret))) throw new Error("Preservation content contains credential material.");
      validatedBlobs.add(object);
    }
  };
  try {
    if (entry.branch !== input.branch) throw new Error("Preservation workspace is no longer on the expected attempt branch.");
    const message = await runGit(input.workspacePath, ["log", "-1", "--format=%B", commitSha], "reading preserved commit message");
    await validateSecrets(commitSha, message);
  } catch (error) {
    return { ...facts, commitSha, captureComplete: false, captureFailure: diagnostic(error), pushed: false, pushFailure: "Preservation push withheld because the committed workspace could not be validated." };
  }
  try {
    const unmerged = await runGit(input.workspacePath, ["ls-files", "--unmerged", "-z"], "inspecting preservation conflicts");
    if (unmerged.length > 0) throw new Error("Unresolved merge conflicts prevent capturing unfinished work; only the last committed HEAD is preserved remotely.");
    const dirty = (await runGit(input.workspacePath, ["status", "--porcelain", "--untracked-files=all"], "inspecting unfinished preservation work")).trim();
    if (dirty.length > 0) {
      const message = "chore: preserve unfinished factory work";
      await runGit(input.workspacePath, ["add", "--all"], "staging unfinished preservation work");
      const tree = (await runGit(input.workspacePath, ["write-tree"], "reading preservation tree")).trim();
      await validateSecrets(tree, message);
      const beforeCommit = await snapshotHeadAndBranch(input.workspacePath);
      if (beforeCommit.branch !== input.branch || beforeCommit.head !== entry.head) throw new Error("Preservation workspace branch or HEAD changed during capture.");
      const parentTree = (await runGit(input.workspacePath, ["rev-parse", `${entry.head}^{tree}`], "reading preserved parent tree")).trim();
      if (tree !== parentTree) {
        await runGitAsRunner(input.workspacePath, ["commit", "-m", message], "committing unfinished preservation work");
        const after = await snapshotHeadAndBranch(input.workspacePath);
        if (after.branch !== input.branch) throw new Error("Preservation commit changed the attempt branch.");
        const parents = (await runGit(input.workspacePath, ["rev-list", "--parents", "-n", "1", after.head], "verifying preservation commit parents")).trim().split(" ");
        if (parents.length !== 2 || parents[1] !== entry.head) throw new Error("Preservation commit does not have the expected single parent.");
        const committedTree = (await runGit(input.workspacePath, ["rev-parse", `${after.head}^{tree}`], "verifying preservation commit tree")).trim();
        if (committedTree !== tree) throw new Error("Preservation commit differs from the validated tree.");
        commitSha = after.head;
      }
    }
    await requireCleanRepository(input.workspacePath, "Preservation capture");
    const captured = await snapshotHeadAndBranch(input.workspacePath);
    if (captured.branch !== input.branch || captured.head !== commitSha) throw new Error("Preservation workspace branch or HEAD changed before capture completed.");
    captureComplete = true;
  } catch (error) {
    captureFailure = diagnostic(error);
  }
  try {
    await runGitAsRunner(input.workspacePath, ["push", "origin", `${commitSha}:refs/heads/${input.branch}`], "preserving the attempt branch");
    return { ...facts, commitSha, captureComplete, captureFailure, pushed: true, pushFailure: undefined };
  } catch (error) {
    return { ...facts, commitSha, captureComplete, captureFailure, pushed: false, pushFailure: diagnostic(error) };
  }
}

