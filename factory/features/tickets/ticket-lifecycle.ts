import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { redactSecret } from "../../shared/redact-secret.js";
import type { SquashPreference } from "../../infrastructure/git-provider/git-provider.js";

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
  squashPreference: SquashPreference;
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
export type ProgressAnnotation = Readonly<{
  timestamp: string;
  cycle: number;
  attemptCount: number;
  reason: string;
  blockedBy?: readonly string[];
}>;

export type PublicationAnnotation = Readonly<{
  timestamp: string;
  groupId: string;
  includedTicketIds: readonly string[];
  finalSha: string;
  pullRequestUrl: string;
}>;

export type TicketLifecycleEvidence = Readonly<{
  hasAttempt: boolean;
  hasCheckpoint: boolean;
  hasPublication: boolean;
  artifactReferences: readonly string[];
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

export type StageCheckpointAnnotation = Readonly<{
  timestamp: string;
  attemptId: string;
  stage: string;
  parentSha: string;
  checkpointSha: string;
  changes: "changed" | "unchanged";
  agentLogBasename: string;
}>;

/** Append the stage checkpoint section recording the runner-owned commit boundary. */
export async function annotateStageCheckpoint(ticketPath: string, checkpoint: StageCheckpointAnnotation): Promise<void> {
  await appendSection(
    ticketPath,
    [
      `## Stage checkpoint ${checkpoint.stage} (${checkpoint.timestamp})`,
      "",
      `- Attempt ID: \`${checkpoint.attemptId}\``,
      `- Stage: \`${checkpoint.stage}\``,
      `- Parent commit: \`${checkpoint.parentSha}\``,
      `- Checkpoint commit: \`${checkpoint.checkpointSha}\``,
      `- Changes: ${checkpoint.changes}`,
      `- Agent log: \`${checkpoint.agentLogBasename}\``,
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
      `- Merge method: squash (${completion.squashPreference})`,
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
export async function annotateRetryable(ticketPath: string, progress: ProgressAnnotation): Promise<void> {
  await appendSection(ticketPath, [
    `## Retryable (${progress.timestamp})`,
    "",
    `- Cycle: ${progress.cycle}`,
    `- Complete attempts: ${progress.attemptCount}`,
    `- Reason: ${progress.reason}`,
  ].join("\n"));
}

export async function annotateBlocked(ticketPath: string, progress: ProgressAnnotation): Promise<void> {
  await appendSection(ticketPath, [
    `## Blocked (${progress.timestamp})`,
    "",
    `- Cycle: ${progress.cycle}`,
    `- Blocked by: ${(progress.blockedBy ?? []).map((id) => `\`${id}\``).join(", ") || "none"}`,
    `- Reason: ${progress.reason}`,
  ].join("\n"));
}

export async function annotatePublication(ticketPath: string, publication: PublicationAnnotation): Promise<void> {
  await appendSection(ticketPath, [
    `## Group publication (${publication.timestamp})`,
    "",
    `- Group: \`${publication.groupId}\``,
    `- Included tickets: ${publication.includedTicketIds.map((id) => `\`${id}\``).join(", ")}`,
    `- Final commit: \`${publication.finalSha}\``,
    `- Draft PR: ${publication.pullRequestUrl}`,
  ].join("\n"));
}

export async function inspectTicketLifecycle(ticketPath: string): Promise<TicketLifecycleEvidence> {
  const source = await readFile(ticketPath, "utf8");
  const references = [...source.matchAll(/^- (?:Workspace|Agent log|Draft PR): (?:`([^`]+)`|(\S+))$/gm)]
    .map((match) => match[1] ?? match[2]!)
    .filter((value, index, all) => all.indexOf(value) === index);
  return {
    hasAttempt: /^## Attempt \S+ \([^)]+\)$/m.test(source),
    hasCheckpoint: /^## Stage checkpoint (?:implement|review) \([^)]+\)$/m.test(source),
    hasPublication: /^## (?:Completed \S+|Group publication) \([^)]+\)$/m.test(source),
    artifactReferences: references,
  };
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
