import { listTicketPaths, loadTicket, type Ticket } from "../tickets/index.js";
import { planTickets } from "../plan-tickets/index.js";
import { executeAttempt } from "./execute-attempt.js";
import { settleMetadataFailure } from "./settle-attempt.js";
import type { ProcessConfig, TicketOutcome } from "./process-config.js";

// One bounded daemon iteration: discover and settle ticket metadata, plan, run attempts, and update terminal bookkeeping.
// Private to the daemon and its behavioral verification; returns the outcomes processed in this iteration.

export async function processIteration(config: ProcessConfig, known: Map<string, Ticket>, terminal: Set<string>): Promise<TicketOutcome[]> {
  for (const path of await listTicketPaths(config.ticketsDir)) {
    try {
      const ticket = await loadTicket(path, config.gitProvider);
      if (!known.has(ticket.id) && !terminal.has(ticket.id)) {
        known.set(ticket.id, ticket);
      }
    } catch (error) {
      await settleMetadataFailure(path, error, config);
    }
  }

  const pending = [...known.values()].filter((ticket) => !terminal.has(ticket.id));
  if (pending.length === 0) {
    return [];
  }

  const planned = await planTickets({ pending, completed: [...terminal], factoryRoot: config.factoryRoot, harness: config.harness, runAgent: config.runAgent });
  const outcomes: TicketOutcome[] = [];
  for (const selection of planned) {
    const ticket = pending.find((candidate) => candidate.id === selection.id);
    if (ticket === undefined) {
      throw new Error(`Planner selected unknown ticket ${selection.id}.`);
    }
    const outcome = await executeAttempt(ticket, config);
    terminal.add(outcome.ticketId);
    known.delete(outcome.ticketId);
    if (outcome.completed) {
      console.log(`Ticket ${outcome.ticketId} completed (attempt ${outcome.attemptId}); moved to ${outcome.destination}.`);
    } else {
      console.log(`Ticket ${outcome.ticketId} failed at ${outcome.failure?.operation}; moved to ${outcome.destination}.`);
    }
    outcomes.push(outcome);
  }
  return outcomes;
}
