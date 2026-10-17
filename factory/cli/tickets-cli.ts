import { resolve } from "node:path";
import { redactSecrets } from "../shared/redact-secret.js";
import { GitHubProvider } from "../infrastructure/git-provider/github-provider.js";
import type { GitProvider } from "../infrastructure/git-provider/git-provider.js";
import { createGitHubBacklog, type GitHubBacklog } from "../infrastructure/github-backlog/index.js";
import { renderJsonReport, renderTextReport, SubmissionGateError, SubmissionLockError, submitTickets, type SubmissionReport, type SubmissionResult } from "../features/submit-tickets/index.js";

// Command-line surface of `npm run tickets -- submit` (plan §3 D3/D12): argument parsing, usage, and
// the client composition root used by factory/tickets-main.ts. The client never runs sandbox preflight,
// never touches the server's queue, and prints help before it reads `.env`, credentials, logging, or the network.

const USAGE = `Usage: npm run tickets -- submit <path ...> [options]

Publish locally authored Markdown tickets into the private GitHub issue backlog: one issue per ticket ID, added to the configured private Project as Backlog, then Ready. Repeat the command to update tickets whose content changed; unchanged tickets are left untouched.

Options:
  <path ...>            Ticket files, directories (top-level *.md, sorted), and glob patterns (*, ?, **)
  --repository <owner/repo>  Backlog repository; overrides FORGE_BACKLOG_REPOSITORY and every ticket's target repository
  --project <url>       Backlog Project V2 URL; overrides FORGE_BACKLOG_PROJECT_URL
  --dry-run             Run every gate and print the planned effect per ticket with zero remote writes
  --json                Print one JSON object (entries, totals, exit status) instead of the text report
  -h, --help            Show this help without reading .env, credentials, logging, or the network

Environment (.env at the repository root, independent from the server's queue):
  FORGE_BACKLOG_REPOSITORY  Private backlog \`owner/repository\`
  FORGE_BACKLOG_PROJECT_URL  Private Project V2 URL, for example https://github.com/orgs/<owner>/projects/<number>; a board view URL (…/views/<number>) is accepted. This setting replaces the removed FORGE_BACKLOG_PROJECT_ID node-id setting.
  FORGE_BACKLOG_TOKEN       Classic PAT: \`repo\` scope for private issues, \`project\` scope for the Project
  GITHUB_TOKEN              Optional target credential; the GitHub provider validates each ticket's repository URL

Exit codes: 0 every ticket created/updated/unchanged, 1 at least one ticket failed, 2 usage, configuration, lock, or privacy gate failure with zero writes.`;

/** A command-line misuse; reported with usage text and exit code 2. */
export class TicketsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketsUsageError";
  }
}

/** Parsed submission flags; `undefined` means help was printed and the process must do nothing else. */
export type TicketsOptions = Readonly<{
  paths: readonly string[];
  repository?: string;
  projectUrl?: string;
  dryRun: boolean;
  json: boolean;
}>;

function printHelp(): void {
  console.log(USAGE);
}

/** Parse the `submit` command; help returns undefined, every other misuse throws a usage error. */
export function parseTicketsArgs(argv: readonly string[]): TicketsOptions | undefined {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return undefined;
  }
  const [command, ...rest] = argv;
  if (command !== "submit") {
    throw new TicketsUsageError(`Unknown tickets command: ${command ?? "<missing>"}. Expected submit. Use --help for usage.`);
  }

  const paths: string[] = [];
  let repository: string | undefined;
  let projectUrl: string | undefined;
  let dryRun = false;
  let json = false;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === "--dry-run") {
      if (dryRun) throw new TicketsUsageError("--dry-run may be supplied only once.");
      dryRun = true;
      continue;
    }
    if (argument === "--json") {
      if (json) throw new TicketsUsageError("--json may be supplied only once.");
      json = true;
      continue;
    }
    if (argument === "--repository" || argument === "--project") {
      const value = rest[++index];
      if (value === undefined || value.startsWith("--")) throw new TicketsUsageError(`${argument} requires a value.`);
      if (argument === "--repository") {
        if (repository !== undefined) throw new TicketsUsageError("--repository may be supplied only once.");
        if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new TicketsUsageError(`--repository must be \`owner/repository\`; got ${value}.`);
        repository = value;
      } else {
        if (projectUrl !== undefined) throw new TicketsUsageError("--project may be supplied only once.");
        projectUrl = value;
      }
      continue;
    }
    if (argument !== undefined && argument.startsWith("--")) throw new TicketsUsageError(`Unknown argument: ${argument}. Use --help for usage.`);
    paths.push(argument ?? "");
  }

  if (paths.length === 0) throw new TicketsUsageError("submit requires at least one ticket path. Use --help for usage.");
  return {
    paths,
    ...(repository === undefined ? {} : { repository }),
    ...(projectUrl === undefined ? {} : { projectUrl }),
    dryRun,
    json,
  };
}

/** The client composition root: everything the submission needs, injectable so tests need no network. */
export type TicketsRuntime = Readonly<{
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  loadEnvironment?: (path: string) => void;
  createBacklog?: (env: NodeJS.ProcessEnv) => Promise<GitHubBacklog>;
  createProvider?: (env: NodeJS.ProcessEnv) => GitProvider;
  now?: () => Date;
  log?: (line: string) => void;
}>;

/** Run one `tickets submit` invocation and return its exit code: 0 success, 1 ticket failure, 2 zero-write refusal. */
export async function runTicketsSubmission(runtime: TicketsRuntime): Promise<number> {
  const cwd = runtime.cwd ?? process.cwd();
  const log = runtime.log ?? ((line: string) => console.log(line));

  let options: TicketsOptions | undefined;
  try {
    options = parseTicketsArgs(runtime.argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(runtime.argv.includes("--json") ? renderJsonReport(refused(2, reason)) : `${reason}\n\n${USAGE}`);
    return 2;
  }
  if (options === undefined) return 0;

  const loadEnvironment = runtime.loadEnvironment ?? defaultLoadEnvironment;
  loadEnvironment(resolve(import.meta.dirname, "../..", ".env"));
  const env: NodeJS.ProcessEnv = { ...process.env, ...runtime.env };

  const report = await submit(runtime, options, env, cwd, log);
  console.log(options.json ? renderJsonReport(report) : renderTextReport(report));
  return report.exitCode;
}

/** Load the repository-root `.env` when it exists; a client with the values already exported needs no file. */
function defaultLoadEnvironment(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
}

function refused(exitCode: number, failure: string, entries: SubmissionResult["entries"] = []): SubmissionReport {
  return { ok: false, exitCode, entries, totals: { created: 0, updated: 0, unchanged: 0, failed: entries.filter((entry) => entry.outcome === "failed").length }, failure };
}

async function submit(runtime: TicketsRuntime, options: TicketsOptions, env: NodeJS.ProcessEnv, cwd: string, log: (line: string) => void): Promise<SubmissionReport> {
  const applyOverrides = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...source,
    ...(options.repository === undefined ? {} : { FORGE_BACKLOG_REPOSITORY: options.repository }),
    ...(options.projectUrl === undefined ? {} : { FORGE_BACKLOG_PROJECT_URL: options.projectUrl }),
  });
  const backlogEnv = applyOverrides(env);

  let provider: GitProvider;
  let backlog: GitHubBacklog;
  try {
    // The provider check is purely local, so a broken target credential fails before the Project URL lookup contacts GitHub.
    provider = (runtime.createProvider ?? githubProviderFromEnv)(backlogEnv);
    backlog = await (runtime.createBacklog ?? createGitHubBacklog)(backlogEnv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return refused(2, redacted(reason, backlogEnv));
  }

  try {
    const result = await submitTickets({
      paths: options.paths,
      backlog,
      provider,
      cwd,
      ...(options.repository === undefined ? {} : { repositoryOverride: options.repository }),
      dryRun: options.dryRun,
      json: options.json,
      ...(runtime.now === undefined ? {} : { now: runtime.now }),
      log,
    });
    const exitCode = result.ok ? 0 : 1;
    return { ok: result.ok, exitCode, entries: result.entries, totals: result.totals };
  } catch (error) {
    if (error instanceof SubmissionGateError || error instanceof SubmissionLockError) {
      return refused(2, redacted(error.message, backlogEnv));
    }
    return refused(2, redacted(`Submission refused: ${error instanceof Error ? error.message : String(error)}`, backlogEnv));
  }
}

/** The GitHub provider that validates ticket repository URLs; no target credential is required for a URL check. */
function githubProviderFromEnv(env: NodeJS.ProcessEnv): GitProvider {
  return new GitHubProvider(env.GITHUB_TOKEN?.trim() ?? "");
}

function redacted(message: string, env: NodeJS.ProcessEnv): string {
  const configured = [env.FORGE_BACKLOG_TOKEN, env.GITHUB_TOKEN, env.AZURE_DEVOPS_PAT];
  return redactSecrets(configured.filter((value): value is string => value !== undefined && value.length > 0), message);
}
