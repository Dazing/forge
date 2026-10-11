import { resolve } from "node:path";
import { toCommandFailure } from "../../infrastructure/git-provider/git.js";
import { PublicationError } from "../publish-pull-request/index.js";
import { annotateFailure, moveTicket, type Ticket } from "../tickets/index.js";
import type { ProcessConfig, TicketOutcome } from "./process-config.js";

// Guarded settlement: metadata failures and attempt failures each get one recorded, annotated, and moved outcome; no recursion.

/** Record one settlement step failure in `main.log` without recursion. */
async function logSettlementFailure(config: ProcessConfig, ticket: Ticket, attemptId: string, step: string, error: unknown): Promise<void> {
  const failure = toCommandFailure(error, step);
  await config.logger.record({
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

/** Settle one unreadable ticket: record, annotate the failure, and move it to `failed/` so the poll continues. */
export async function settleMetadataFailure(path: string, error: unknown, config: ProcessConfig): Promise<void> {
  const timestamp = new Date().toISOString();
  const failure = toCommandFailure(error, "ticket metadata");
  await config.logger.record({ timestamp, stage: "ticket metadata", operation: "loading ticket", status: "failed", stdout: failure.stdout, stderr: failure.stderr });
  try {
    await annotateFailure(path, { timestamp, attemptId: "", stage: "ticket metadata", command: failure.command, exitCode: failure.exitCode, stdout: failure.stdout, stderr: failure.stderr, secret: config.gitProvider.credential });
  } catch (annotationError) {
    await config.logger.record({ timestamp, stage: "failure annotation", operation: "annotating failure", status: "failed", stderr: String(annotationError) });
  }
  try {
    const destination = await moveTicket(path, resolve(config.ticketsDir, "failed"), "");
    console.log(`Ticket ${path} failed metadata validation; moved to ${destination}.`);
  } catch (movementError) {
    await config.logger.record({ timestamp, stage: "terminal movement", operation: "moving ticket to failed directory", status: "failed", stderr: String(movementError) });
    console.log(`Ticket ${path} failed metadata validation; movement to failed/ failed: ${String(movementError)}`);
  }
}

/** Settle a failed attempt: record the failure, then guarded annotation and movement to `failed/`; publication substages unwrap to their original diagnostics. */
export async function settleAttemptFailure(ticket: Ticket, attemptId: string, stage: string, error: unknown, config: ProcessConfig): Promise<TicketOutcome> {
  const failureStage = error instanceof PublicationError ? error.substage : stage;
  const failure = toCommandFailure(error instanceof PublicationError ? error.cause : error, failureStage);
  const timestamp = new Date().toISOString();
  await config.logger.record({
    timestamp,
    ticketId: ticket.id,
    attemptId,
    stage: failureStage,
    operation: failure.operation,
    status: "failed",
    stdout: failure.stdout,
    stderr: failure.stderr,
  });

  // The terminal transition is owned here: annotation and movement each get one guarded attempt, no recursion.
  try {
    await annotateFailure(ticket.path, {
      timestamp,
      attemptId,
      stage: failureStage,
      command: failure.command,
      exitCode: failure.exitCode,
      stdout: failure.stdout,
      stderr: failure.stderr,
      secret: config.gitProvider.credential,
    });
  } catch (annotationError) {
    await logSettlementFailure(config, ticket, attemptId, "failure annotation", annotationError);
  }

  try {
    const destination = await moveTicket(ticket.path, resolve(config.ticketsDir, "failed"), attemptId);
    return { ticketId: ticket.id, attemptId, completed: false, destination, failure };
  } catch (movementError) {
    await logSettlementFailure(config, ticket, attemptId, "terminal movement", movementError);
    return { ticketId: ticket.id, attemptId, completed: false, destination: "", failure };
  }
}

export { logSettlementFailure };
