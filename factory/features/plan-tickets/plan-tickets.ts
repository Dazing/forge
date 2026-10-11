import { Output } from "@ai-hero/sandcastle";
import { resolve } from "node:path";
import { requireUnchanged, snapshotRepository } from "../../infrastructure/git-provider/git.js";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import type { AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import type { Ticket } from "../tickets/index.js";
import { planSchema, validatePlan, type PlannedTicket } from "./plan-schema.js";

// Planning iteration: run the read-only planner from the factory checkout, validate the selection,
// and require the factory HEAD and porcelain status to be unchanged around the planner run.

export interface PlanTicketsInput {
  readonly pending: readonly Ticket[];
  readonly completed: readonly string[];
  readonly factoryRoot: string;
  readonly harness: AgentHarness;
  readonly runAgent: AgentRunner;
}

/** Render tickets as tagged prompt blocks with stable IDs, titles, repository context, and body content. */
function formatTickets(tickets: readonly Ticket[]): string {
  return tickets
    .map(
      (ticket) =>
        `<ticket id="${ticket.id}" name=${JSON.stringify(ticket.name)} title=${JSON.stringify(ticket.title)} repository="${ticket.repository}" base-branch="${ticket.baseBranch}">\n` +
        `<host-path>${ticket.path}</host-path>\n` +
        `<content>\n${ticket.content}\n</content>\n` +
        `</ticket>`,
    )
    .join("\n\n");
}

/** Plan one iteration; returns validated selections, not the raw Sandcastle result. */
export async function planTickets(input: PlanTicketsInput): Promise<PlannedTicket[]> {
  const factoryBefore = await snapshotRepository(input.factoryRoot);
  const plan = await input.runAgent({
    cwd: input.factoryRoot,
    harness: input.harness,
    name: "plan",
    logName: "plan",
    promptFile: resolve(import.meta.dirname, "plan-prompt.md"),
    promptArgs: { TICKETS: formatTickets(input.pending), COMPLETED_TICKET_IDS: input.completed.length === 0 ? "none" : input.completed.join(", ") },
    completionSignal: "</plan>",
    output: Output.object({ tag: "plan", schema: planSchema }),
  });
  if (plan.completionSignal !== "</plan>") {
    throw new Error("planner did not complete");
  }
  const planned = validatePlan(plan.output.tickets, new Map(input.pending.map((ticket) => [ticket.id, ticket] as const)), new Set(input.completed));
  requireUnchanged("planning stage", "factory", factoryBefore, await snapshotRepository(input.factoryRoot));
  return planned;
}
