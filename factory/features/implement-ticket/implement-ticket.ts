import { resolve } from "node:path";
import { MissingAgentHandoffError } from "../../infrastructure/agent-runtime/handoff.js";
import type { AgentRunRequest, AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import { requireCleanRepository, snapshotHeadAndBranch } from "../../infrastructure/git-provider/git.js";
import type { Ticket } from "../tickets/index.js";
import { implementHandoff, type ImplementStageResult } from "./implement-schema.js";

const MAX_ITERATIONS = 3;

export interface ImplementTicketInput {
  ticket: Ticket;
  workspacePath: string;
  branch: string;
  attemptId: string;
  harness: AgentHarness;
  runAgent: AgentRunner;
  dependencies?: readonly Readonly<{ id: string; title: string; checkpointSha: string; summary: string }>[];
}

/** Validated stage message plus the HEAD the stage started from, which the checkpoint verifies against. */
export type ImplementOutcome = Readonly<{
  message: string;
  head: string;
}>;

/**
 * Runs the implementation agent in the ticket workspace, up to three single-iteration runs.
 * A missing handoff consumes another iteration in the same uncommitted workspace. Accepted
 * handoffs and infrastructure failures return immediately to controller-owned postconditions.
 * The agent never commits; the runner creates the checkpoint after this stage succeeds.
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
          DEPENDENCIES: input.dependencies?.map((dependency) => `${dependency.id} (${dependency.checkpointSha}): ${dependency.summary}`).join("\n") ?? "none",
          BRANCH: input.branch,
          BASE_BRANCH: input.ticket.baseBranch,
        },
        handoff: implementHandoff,
        maxIterations: 1,
      };
      const result = await input.runAgent(request);
      return { message: result.handoff.message, head: entry.head };
    } catch (error) {
      if (!(error instanceof MissingAgentHandoffError)) throw error;
      lastFailure = error;
    }
  }

  throw new Error(`implementation agent did not complete for ticket ${input.ticket.id} after ${MAX_ITERATIONS} iterations`, { cause: lastFailure });
}
