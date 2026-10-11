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

/** Require a clean index and worktree, including untracked files, before advancing a stage. */
export async function requireCleanRepository(repository: string, stage: string): Promise<void> {
  const status = (await runGit(repository, ["status", "--porcelain"], "inspecting branch worktree")).trim();
  if (status.length === 0) return;

  throw new Error(`${stage} left uncommitted changes in the branch worktree: ${status.replaceAll("\n", ", ")}`);
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
