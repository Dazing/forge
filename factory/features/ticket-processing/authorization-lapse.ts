import { runGit, runGitAsRunner } from "../../infrastructure/git-provider/git.js";
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
}>;

/** Push one preserved attempt branch (never a pull request) and report the facts the issue comment must carry. */
export async function preserveAttemptWorkspace(input: Readonly<{
  attemptId: string;
  branch: string;
  repository: string;
  baseBranch: string;
  workspacePath: string;
  secrets: readonly string[];
}>): Promise<PreservedAttempt> {
  const commitSha = (await runGit(input.workspacePath, ["rev-parse", "HEAD"], "reading the preserved commit SHA")).trim();
  try {
    await runGitAsRunner(input.workspacePath, ["push", "origin", `HEAD:refs/heads/${input.branch}`], "preserving the attempt branch");
    return { ...input, commitSha, pushed: true, pushFailure: undefined };
  } catch (error) {
    const report = error instanceof Error ? error.message : String(error);
    return { ...input, commitSha, pushed: false, pushFailure: redactSecrets(input.secrets, report).slice(0, 240) };
  }
}

