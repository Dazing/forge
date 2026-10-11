import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { redactSecret } from "../shared/invocation-log.js";

// Append-only ticket annotations and collision-safe movement into done/ and failed/, split from orchestration.

export type AttemptAnnotation = Readonly<{
  timestamp: string;
  attemptId: string;
  workspacePath: string;
  branch: string;
  repository: string;
  baseBranch: string;
}>;

export type CompletionAnnotation = Readonly<{
  timestamp: string;
  attemptId: string;
  workspacePath: string;
  branch: string;
  baseBranch: string;
  finalSha: string;
  pullRequestUrl: string;
}>;

export type FailureAnnotation = Readonly<{
  timestamp: string;
  attemptId: string;
  stage: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  secret: string;
}>;

function fence(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Append one Markdown section to the ticket file, separated from prior content. */
async function appendSection(ticketPath: string, section: string): Promise<void> {
  await appendFile(ticketPath, `\n${section}\n`);
}

/** Append the attempt section recording identity, workspace, branch, repository, and base branch. */
export async function annotateAttempt(ticketPath: string, attempt: AttemptAnnotation): Promise<void> {
  await appendSection(
    ticketPath,
    [
      `## Attempt ${attempt.attemptId} (${attempt.timestamp})`,
      "",
      `- Attempt ID: \`${attempt.attemptId}\``,
      `- Workspace: \`${attempt.workspacePath}\``,
      `- Branch: \`${attempt.branch}\``,
      `- Repository: \`${attempt.repository}\``,
      `- Base branch: \`${attempt.baseBranch}\``,
    ].join("\n"),
  );
}

/** Append the completion section recording timestamp, attempt, workspace, branch, base branch, final SHA, and draft PR URL. */
export async function annotateCompletion(ticketPath: string, completion: CompletionAnnotation): Promise<void> {
  await appendSection(
    ticketPath,
    [
      `## Completed ${completion.attemptId} (${completion.timestamp})`,
      "",
      `- Attempt ID: \`${completion.attemptId}\``,
      `- Workspace: \`${completion.workspacePath}\``,
      `- Branch: \`${completion.branch}\``,
      `- Base branch: \`${completion.baseBranch}\``,
      `- Final commit: \`${completion.finalSha}\``,
      `- Draft PR: ${completion.pullRequestUrl}`,
    ].join("\n"),
  );
}

/** Append the failure section with sanitized command, exit code/HTTP status, and fenced stdout/stderr. */
export async function annotateFailure(ticketPath: string, failure: FailureAnnotation): Promise<void> {
  const stdout = redactSecret(failure.secret, failure.stdout);
  const stderr = redactSecret(failure.secret, failure.stderr);
  await appendSection(
    ticketPath,
    [
      `## Failed at stage \`${failure.stage}\` (${failure.timestamp})`,
      "",
      `- Attempt ID: \`${failure.attemptId}\``,
      `- Stage: \`${failure.stage}\``,
      `- Command: \`${redactSecret(failure.secret, failure.command)}\` (exit code / HTTP status: ${failure.exitCode})`,
      "- stdout:",
      fence(stdout) + "text",
      stdout,
      fence(stdout),
      "- stderr:",
      fence(stderr) + "text",
      stderr,
      fence(stderr),
    ].join("\n"),
  );
}

/** Move a ticket into a lifecycle directory, preserving its filename and appending the attempt ID on collision. */
export async function moveTicket(ticketPath: string, destinationDir: string, attemptId: string): Promise<string> {
  await mkdir(destinationDir, { recursive: true });
  const filename = basename(ticketPath);
  const destination = join(destinationDir, filename);
  const occupied = await stat(destination).catch(() => undefined);
  const finalPath = occupied ? join(destinationDir, `${basename(filename, extname(filename))}-${attemptId}.md`) : destination;
  if (occupied && (await stat(finalPath).catch(() => undefined))) {
    throw new Error(`Destination ticket already exists: ${finalPath}`);
  }
  await rename(ticketPath, finalPath);
  return finalPath;
}
