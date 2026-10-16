import { toCommandFailure } from "../../infrastructure/git-provider/git.js";
import type { Ticket } from "../tickets/index.js";
import type { ProcessConfig } from "./process-config.js";
import type { MainLogRecord } from "../../infrastructure/logging/invocation-log.js";
import { redactSecrets } from "../../shared/redact-secret.js";

// Guarded settlement diagnostics; a failed record never changes an already settled outcome and never retries recursively.

/** Logging failure must not prevent terminal settlement or change an already published outcome. */
async function recordSettlement(config: ProcessConfig, record: MainLogRecord): Promise<void> {
  try {
    await config.logger.record(record);
  } catch (error) {
    const diagnostic = redactSecrets(config.providers.secrets, JSON.stringify({ ...record, loggingError: error instanceof Error ? error.message : String(error) }));
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

/** Record one backlog effect failure (issue comment, status, closure) in `main.log` without recursion. */
export async function logBacklogFailure(config: ProcessConfig, ticketId: string, stage: string, error: unknown): Promise<void> {
  const failure = toCommandFailure(error, stage);
  await recordSettlement(config, {
    timestamp: new Date().toISOString(),
    ticketId,
    stage,
    operation: failure.operation,
    status: "failed",
    stdout: failure.stdout,
    stderr: failure.stderr,
  });
}

/** Record and surface one scheduling block without exposing provider credentials. */
async function reportBlocked(config: ProcessConfig, ticket: Ticket, reason: string): Promise<void> {
  const safeReason = redactSecrets(config.providers.secrets, reason);
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

export { logSettlementFailure, reportBlocked };
