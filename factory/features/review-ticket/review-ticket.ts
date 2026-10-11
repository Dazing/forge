import { resolve } from "node:path";
import { requireCleanRepository } from "../../infrastructure/git-provider/git.js";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import type { Ticket } from "../tickets/index.js";

// Review stage: one bounded agent run, then the clean-workspace postcondition that gates publication.

const COMPLETE = "<promise>COMPLETE</promise>";
const MAX_ITERATIONS = 3;

export interface ReviewTicketInput {
  readonly ticket: Ticket;
  readonly workspacePath: string;
  readonly branch: string;
  readonly attemptId: string;
  readonly harness: AgentHarness;
  readonly runAgent: AgentRunner;
}

/** Run the review agent; rejects when it does not complete, and when the review leaves uncommitted changes in the workspace. */
export async function reviewTicket(input: ReviewTicketInput): Promise<void> {
  const result = await input.runAgent({
    cwd: input.workspacePath,
    harness: input.harness,
    name: `review-${input.ticket.id}-${input.attemptId}`,
    logName: `review-${input.ticket.id}-${input.attemptId}`,
    promptFile: resolve(import.meta.dirname, "review-prompt.md"),
    promptArgs: { TICKET_ID: input.ticket.id, TICKET_TITLE: input.ticket.title, BRANCH: input.branch, BASE_BRANCH: input.ticket.baseBranch, TICKET_CONTENT: input.ticket.content },
    completionSignal: COMPLETE,
    maxIterations: MAX_ITERATIONS,
  });
  if (result.completionSignal !== COMPLETE) {
    throw new Error("review agent did not complete");
  }
  await requireCleanRepository(input.workspacePath, `Review for ticket ${input.ticket.id}`);
}
