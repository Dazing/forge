import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

// Git subprocess client for the target repository, split from main.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

const execFile = promisify(execFileCallback);

/** Run one git command in the target repository and return its stdout; names the operation and repository when git fails. */
export async function runGit(repo: string, args: readonly string[], operation: string): Promise<string> {
  try {
    const result = await execFile("git", ["-C", repo, ...args]);
    return result.stdout;
  } catch (error) {
    throw new Error(`Git failed while ${operation} in target repository ${repo}.`, { cause: error });
  }
}
