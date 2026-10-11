import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "./cli/cli.js";
import { solveTickets } from "./orchestration/ticket-orchestrator.js";
import { preflightSandbox } from "./sandbox/sandbox.js";
import { toCommandFailure } from "./git-provider/git.js";
import { createGitProvider } from "./git-provider/create-git-provider.js";
import { InvocationLogger } from "./shared/invocation-log.js";
import { requireDirectory } from "./shared/paths.js";
import { sleep } from "./shared/sleep.js";
import { annotateFailure, moveTicket } from "./tickets/ticket-lifecycle.js";
import { listTicketPaths, loadTicket, TicketMetadataError, type Ticket } from "./tickets/tickets.js";

// Composition root for the Sandcastle runner: the daemon main loop and ticket bookkeeping.
// CLI parsing lives in cli/cli.ts, the per-iteration ticket lifecycle in orchestration/ticket-orchestrator.ts,
// git provider integration lives in git-provider/, path checks in shared/, sandbox preflight in sandbox/sandbox.ts, and agent stage runs in harness/harness-agents.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

const TICKET_POLL_MS = 10_000;

/** Settle one unreadable ticket: record, annotate the failure, and move it to `failed/` so the poll continues. */
async function settleMetadataFailure(path: string, error: unknown, ticketsDir: string, secret: string, logger: InvocationLogger): Promise<void> {
  const attemptId = randomBytes(3).toString("hex");
  const stage = "ticket metadata";
  const failure = error instanceof TicketMetadataError ? error.failure : toCommandFailure(error, stage);
  const timestamp = new Date().toISOString();
  await logger.record({ timestamp, attemptId, stage, operation: failure.operation, status: "failed", stdout: failure.stdout, stderr: failure.stderr });
  try {
    await annotateFailure(path, {
      timestamp,
      attemptId,
      stage,
      command: failure.command,
      exitCode: failure.exitCode,
      stdout: failure.stdout,
      stderr: failure.stderr,
      secret,
    });
  } catch (annotationError) {
    await logger.record({ timestamp, attemptId, stage: "failure annotation", operation: "annotating failure", status: "failed", stderr: String(annotationError) });
  }
  try {
    const destination = await moveTicket(path, resolve(ticketsDir, "failed"), attemptId);
    console.log(`Ticket ${path} failed metadata validation; moved to ${destination}.`);
  } catch (movementError) {
    await logger.record({ timestamp, attemptId, stage: "terminal movement", operation: "moving ticket to failed directory", status: "failed", stderr: String(movementError) });
    console.log(`Ticket ${path} failed metadata validation; movement to failed/ failed: ${String(movementError)}`);
  }
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const factoryRoot = resolve(import.meta.dirname, "..");
  process.loadEnvFile(resolve(factoryRoot, ".env"));
  const gitProvider = createGitProvider(process.env);
  const ticketsDir = resolve(options.ticketsDir);
  await requireDirectory(ticketsDir, "Ticket directory");
  const logger = await InvocationLogger.create(factoryRoot, gitProvider.credential);
  await preflightSandbox(options.agentHarness);

  const known = new Map<string, Ticket>();
  const terminal = new Set<string>();
  let iteration = 0;
  const stayAlive = true;
  while (stayAlive) {
    iteration++;
    for (const path of await listTicketPaths(ticketsDir)) {
      try {
        const ticket = await loadTicket(path, gitProvider);
        if (!known.has(ticket.id) && !terminal.has(ticket.id)) {
          known.set(ticket.id, ticket);
        }
      } catch (error) {
        await settleMetadataFailure(path, error, ticketsDir, gitProvider.credential, logger);
      }
    }

    const pending = [...known.values()].filter((ticket) => !terminal.has(ticket.id));
    if (pending.length === 0) {
      console.log(`[poll] No pending tickets; sleeping ${TICKET_POLL_MS / 1000} seconds.`);
      await sleep(TICKET_POLL_MS);
      continue;
    }

    const outcomes = await solveTickets({
      ticketsDir,
      factoryRoot,
      harness: options.agentHarness,
      iteration,
      pending,
      completed: [...terminal],
      logger,
      gitProvider,
    });
    for (const outcome of outcomes) {
      terminal.add(outcome.ticketId);
      known.delete(outcome.ticketId);
      if (outcome.completed) {
        console.log(`Ticket ${outcome.ticketId} completed (attempt ${outcome.attemptId}); moved to ${outcome.destination}.`);
      } else {
        console.log(`Ticket ${outcome.ticketId} failed at ${outcome.failure?.operation}; moved to ${outcome.destination}.`);
      }
    }
  }
}

await run();
