import { resolve } from "node:path";
import { toCommandFailure } from "../../infrastructure/git-provider/git.js";
import { annotateFailure, moveTicket, type Ticket } from "../tickets/index.js";
import type { ProcessConfig } from "./process-config.js";
import type { MainLogRecord } from "../../infrastructure/logging/invocation-log.js";
import { redactSecret } from "../../shared/redact-secret.js";

// Guarded metadata and publication settlement diagnostics; no recursive retries.

/** Logging failure must not prevent terminal settlement or change an already published outcome. */
async function recordSettlement(config: ProcessConfig, record: MainLogRecord): Promise<void> {
  try {
    await config.logger.record(record);
  } catch (error) {
    let diagnostic = JSON.stringify({ ...record, loggingError: error instanceof Error ? error.message : String(error) });
    for (const secret of config.gitProvider.secrets()) {
      diagnostic = redactSecret(secret, diagnostic);
    }
    console.error(diagnostic);
  }
}

/** Record one settlement step failure in `main.log` without recursion. */
async function logSettlementFailure(config: ProcessConfig, ticket: Ticket, attemptId: string, step: string, error: unknown): Promise<void> {
  const failure = toCommandFailure(error, step);
  await recordSettlement(config, {
    timestamp: new Date().toISOString(),
    ticketId: ticket.id,
    attemptId,
    stage: step,
    operation: failure.operation,
    status: "failed",
    stdout: failure.stdout,
    stderr: failure.stderr,
  });
}

/** Record and surface one scheduling block without exposing provider credentials. */
async function reportBlocked(config: ProcessConfig, ticket: Ticket, reason: string): Promise<void> {
  let safeReason = reason;
  for (const secret of config.gitProvider.secrets()) {
    safeReason = redactSecret(secret, safeReason);
  }
  await recordSettlement(config, {
    timestamp: new Date().toISOString(),
    ticketId: ticket.id,
    stage: "scheduling",
    operation: "blocking ticket",
    status: "blocked",
    stderr: safeReason,
  });
  console.error(`Ticket ${ticket.id} is blocked: ${safeReason}`);
}

/** Settle one unreadable ticket: record, annotate the failure, and move it to `failed/` so the poll continues. */
export async function settleMetadataFailure(path: string, error: unknown, config: ProcessConfig): Promise<void> {
  const timestamp = new Date().toISOString();
  const failure = toCommandFailure(error, "ticket metadata");
  await recordSettlement(config, { timestamp, stage: "ticket metadata", operation: "loading ticket", status: "failed", stdout: failure.stdout, stderr: failure.stderr });
  try {
    await annotateFailure(path, { timestamp, attemptId: "", stage: "ticket metadata", command: failure.command, exitCode: failure.exitCode, stdout: failure.stdout, stderr: failure.stderr, secret: config.gitProvider.credential });
  } catch (annotationError) {
    await recordSettlement(config, { timestamp, stage: "failure annotation", operation: "annotating failure", status: "failed", stderr: String(annotationError) });
  }
  try {
    const destination = await moveTicket(path, resolve(config.ticketsDir, "failed"), "");
    console.log(`Ticket ${path} failed metadata validation; moved to ${destination}.`);
  } catch (movementError) {
    await recordSettlement(config, { timestamp, stage: "terminal movement", operation: "moving ticket to failed directory", status: "failed", stderr: String(movementError) });
    console.log(`Ticket ${path} failed metadata validation; movement to failed/ failed: ${String(movementError)}`);
  }
}


export { logSettlementFailure, reportBlocked };
