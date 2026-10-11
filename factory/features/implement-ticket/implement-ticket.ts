import { Output, StructuredOutputError } from "@ai-hero/sandcastle";
import { resolve } from "node:path";
import type { AgentRunRequest, AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import { requireCleanRepository, snapshotHeadAndBranch } from "../../infrastructure/git-provider/git.js";
import type { Ticket } from "../tickets/index.js";
import { implementSchema, type ImplementStageResult } from "./implement-schema.js";

const COMPLETE = "<promise>COMPLETE</promise>";
const MAX_ITERATIONS = 3;

export interface ImplementTicketInput {
  ticket: Ticket;
  workspacePath: string;
  branch: string;
  attemptId: string;
  harness: AgentHarness;
  runAgent: AgentRunner;
}

/** Validated stage message plus the HEAD the stage started from, which the checkpoint verifies against. */
export type ImplementOutcome = Readonly<{
  message: string;
  head: string;
}>;

/**
 * Runs the implementation agent in the ticket workspace, up to three single-iteration runs.
 * Sandcastle supports structured output only for single-iteration runs, so the runner owns the
 * iteration loop: each run reports one validated stage message, and uncommitted stage work
 * persists in the workspace for the next iteration. The agent never commits; the runner creates
 * the checkpoint after this stage succeeds.
 */
export async function implementTicket(input: ImplementTicketInput): Promise<ImplementOutcome> {
  await requireCleanRepository(input.workspacePath, `Implementation entry for ticket ${input.ticket.id}`);
  const entry = await snapshotHeadAndBranch(input.workspacePath);
  if (entry.branch !== input.branch) {
    throw new Error(`implementation stage requires ticket workspace on branch ${input.branch}, found ${entry.branch}.`);
  }

  let lastFailure: unknown = new Error("the implementation agent produced no result");
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    try {
      const request: AgentRunRequest<ImplementStageResult> = {
        cwd: input.workspacePath,
        harness: input.harness,
        name: `implement-${input.ticket.slug}`,
        logName: `implement-${input.ticket.id}-${input.attemptId}`,
        promptFile: resolve(import.meta.dirname, "implement-prompt.md"),
        promptArgs: {
          TICKET_ID: input.ticket.id,
          TICKET_TITLE: input.ticket.title,
          TICKET_CONTENT: input.ticket.content,
          BRANCH: input.branch,
          BASE_BRANCH: input.ticket.baseBranch,
        },
        completionSignal: COMPLETE,
        output: Output.object({ tag: "implementation", schema: implementSchema }),
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

  throw new Error(`implementation agent did not complete for ticket ${input.ticket.id} after ${MAX_ITERATIONS} iterations`, { cause: lastFailure });
}
