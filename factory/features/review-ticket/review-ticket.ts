import { Output, StructuredOutputError } from "@ai-hero/sandcastle";
import { resolve } from "node:path";
import type { AgentRunRequest, AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import { requireCleanRepository, snapshotHeadAndBranch } from "../../infrastructure/git-provider/git.js";
import type { Ticket } from "../tickets/index.js";
import { reviewSchema, type ReviewStageResult } from "./review-schema.js";

const COMPLETE = "<promise>COMPLETE</promise>";
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
}>;

/**
 * Runs the review agent in the ticket workspace, up to three single-iteration runs. Sandcastle
 * supports structured output only for single-iteration runs, so the runner owns the iteration
 * loop. The reviewer inspects the uncommitted implementation work, may make small corrections,
 * and reports one validated stage message. The reviewer never commits; the runner creates the
 * checkpoint after this stage succeeds, and cleanliness of the resulting workspace is enforced
 * at that boundary.
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
        logName: `review-${input.ticket.id}-${input.attemptId}`,
        promptFile: resolve(import.meta.dirname, "review-prompt.md"),
        promptArgs: {
          TICKET_ID: input.ticket.id,
          TICKET_TITLE: input.ticket.title,
          TICKET_CONTENT: input.ticket.content,
          BRANCH: input.branch,
          BASE_BRANCH: input.ticket.baseBranch,
        },
        completionSignal: COMPLETE,
        output: Output.object({ tag: "review", schema: reviewSchema }),
        maxIterations: 1,
      };
      const result = await input.runAgent(request);
      if (result.completionSignal === COMPLETE) {
        return { message: result.output.message, head: entry.head };
      }
      lastFailure = new Error(`iteration ${iteration} ended without the completion signal`);
    } catch (error) {
      // A run that fails to produce a valid structured message is a failed iteration; the next
      // iteration continues from the same uncommitted stage work. Infrastructure failures are fatal.
      if (!(error instanceof StructuredOutputError)) {
        throw error;
      }
      lastFailure = error;
    }
  }

  throw new Error(`review agent did not complete for ticket ${input.ticket.id} after ${MAX_ITERATIONS} iterations`, { cause: lastFailure });
}
