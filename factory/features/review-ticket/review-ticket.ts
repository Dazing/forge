import { resolve } from "node:path";
import { MissingAgentHandoffError } from "../../infrastructure/agent-runtime/handoff.js";
import type { AgentRunRequest, AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import { requireCleanRepository, snapshotHeadAndBranch } from "../../infrastructure/git-provider/git.js";
import type { Ticket } from "../tickets/index.js";
import { reviewHandoff, type ReviewStageResult } from "./review-schema.js";

const MAX_ITERATIONS = 3;

export interface ReviewTicketInput {
  ticket: Ticket;
  workspacePath: string;
  branch: string;
  attemptId: string;
  harness: AgentHarness;
  runAgent: AgentRunner;
}

/** Validated stage message plus the HEAD the stage started from, which the checkpoint verifies against. */
export type ReviewOutcome = Readonly<{
  message: string;
  head: string;
  logReference: string;
}>;

/**
 * Runs the review agent in the ticket workspace, up to three single-iteration runs. A missing
 * handoff consumes another iteration in the same uncommitted workspace. The reviewer inspects
 * implementation work, may make small corrections, and never commits; the runner creates the
 * checkpoint after an accepted handoff.
 */
export async function reviewTicket(input: ReviewTicketInput): Promise<ReviewOutcome> {
  await requireCleanRepository(input.workspacePath, `Review entry for ticket ${input.ticket.id}`);
  const entry = await snapshotHeadAndBranch(input.workspacePath);
  if (entry.branch !== input.branch) {
    throw new Error(`review stage requires ticket workspace on branch ${input.branch}, found ${entry.branch}.`);
  }

  let lastFailure: unknown = new Error("the review agent produced no result");
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    try {
      const request: AgentRunRequest<ReviewStageResult> = {
        cwd: input.workspacePath,
        harness: input.harness,
        name: `review-${input.ticket.slug}`,
        logTarget: { scope: "attempt", attemptId: input.attemptId, stage: "review" },
        promptFile: resolve(import.meta.dirname, "review-prompt.md"),
        promptArgs: {
          TICKET_ID: input.ticket.id,
          TICKET_TITLE: input.ticket.title,
          TICKET_CONTENT: input.ticket.content,
          BRANCH: input.branch,
          BASE_BRANCH: input.ticket.baseBranch,
        },
        handoff: reviewHandoff,
        maxIterations: 1,
      };
      const result = await input.runAgent(request);
      return { message: result.handoff.message, head: entry.head, logReference: result.logReference };
    } catch (error) {
      if (!(error instanceof MissingAgentHandoffError)) throw error;
      lastFailure = error;
    }
  }

  throw new Error(`review agent did not complete for ticket ${input.ticket.id} after ${MAX_ITERATIONS} iterations`, { cause: lastFailure });
}
