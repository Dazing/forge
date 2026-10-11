import { resolve } from "node:path";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import type { Ticket } from "../tickets/index.js";

// Implementation stage: one bounded agent run on the ticket workspace; completion is the success condition.

const COMPLETE = "<promise>COMPLETE</promise>";
const MAX_ITERATIONS = 3;

export interface ImplementTicketInput {
  readonly ticket: Ticket;
  readonly workspacePath: string;
  readonly branch: string;
  readonly attemptId: string;
  readonly harness: AgentHarness;
  readonly runAgent: AgentRunner;
}

/** Run the implementation agent; rejects when it does not emit the completion signal within the iteration limit. */
export async function implementTicket(input: ImplementTicketInput): Promise<void> {
  const result = await input.runAgent({
    cwd: input.workspacePath,
    harness: input.harness,
    name: `implement-${input.ticket.id}-${input.attemptId}`,
    logName: `implement-${input.ticket.id}-${input.attemptId}`,
    promptFile: resolve(import.meta.dirname, "implement-prompt.md"),
    promptArgs: { TICKET_ID: input.ticket.id, TICKET_TITLE: input.ticket.title, BRANCH: input.branch, BASE_BRANCH: input.ticket.baseBranch, TICKET_CONTENT: input.ticket.content },
    completionSignal: COMPLETE,
    maxIterations: MAX_ITERATIONS,
  });
  if (result.completionSignal !== COMPLETE) {
    throw new Error("implementation agent did not complete");
  }
}
