import { Output, StructuredOutputError } from "@ai-hero/sandcastle";
import { resolve } from "node:path";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { CommandFailedError, currentBranch, requireNoUnmergedEntries, runGit } from "../../infrastructure/git-provider/git.js";
import type { AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import { integrateSchema, type IntegrateStageResult } from "./integrate-schema.js";

const COMPLETE = "<promise>COMPLETE</promise>";
const MAX_ITERATIONS = 3;

export interface IntegrateTicketsInput {
  readonly groupId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly includedTickets: readonly Readonly<{ id: string; title: string; checkpointSha: string; summary: string }>[];
  readonly conflictPaths: readonly string[];
  readonly task: "resolve-and-review" | "combined-review";
  readonly harness: AgentHarness;
  readonly runAgent: AgentRunner;
}

export type IntegrateTicketsOutcome = Readonly<{
  message: string;
  conflicts: readonly Readonly<{ path: string; disposition: string }>[];
  head: string;
}>;

export async function integrateTickets(input: IntegrateTicketsInput): Promise<IntegrateTicketsOutcome> {
  const head = (await runGit(input.workspacePath, ["rev-parse", "HEAD"], "reading integration entry HEAD")).trim();
  if (await currentBranch(input.workspacePath) !== input.branch) throw new Error(`Integration workspace must remain on ${input.branch}.`);
  let lastFailure: unknown = new Error("integration agent produced no result");
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    try {
      const result = await input.runAgent<IntegrateStageResult>({
        cwd: input.workspacePath,
        harness: input.harness,
        name: `integrate-${input.groupId}`,
        logName: `integrate-${input.groupId}`,
        promptFile: resolve(import.meta.dirname, "integrate-prompt.md"),
        promptArgs: {
          GROUP_ID: input.groupId,
          BRANCH: input.branch,
          TASK: input.task,
          TICKETS: input.includedTickets.map((ticket) => `${ticket.id} (${ticket.checkpointSha}) ${ticket.title}: ${ticket.summary}`).join("\n"),
          CONFLICT_PATHS: input.conflictPaths.join("\n") || "none",
        },
        completionSignal: COMPLETE,
        output: Output.object({ tag: "integration", schema: integrateSchema }),
        maxIterations: 1,
      });
      if (result.completionSignal !== COMPLETE) {
        lastFailure = new Error(`iteration ${iteration} ended without the completion signal`);
        continue;
      }
      if (await currentBranch(input.workspacePath) !== input.branch) throw new Error(`Integration agent changed branch from ${input.branch}.`);
      if ((await runGit(input.workspacePath, ["rev-parse", "HEAD"], "checking integration HEAD")).trim() !== head) throw new Error("Integration agent created or changed a commit; only the runner may commit.");
      await requireNoUnmergedEntries(input.workspacePath, "integration completion");
      const dispositionPaths = new Set(result.output.conflicts.map((conflict) => conflict.path));
      const missingDispositions = input.conflictPaths.filter((path) => !dispositionPaths.has(path));
      if (missingDispositions.length > 0) throw new Error(`Integration omitted conflict dispositions for: ${missingDispositions.join(", ")}.`);
      let tracked = "";
      try {
        tracked = await runGit(input.workspacePath, ["grep", "-n", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", "."], "checking conflict markers");
      } catch (error) {
        if (!(error instanceof CommandFailedError) || error.failure.exitCode !== 1) throw error;
      }
      if (tracked.trim().length > 0) throw new Error(`Integration left conflict markers:\n${tracked.trim()}`);
      return { message: result.output.message, conflicts: result.output.conflicts, head };
    } catch (error) {
      if (!(error instanceof StructuredOutputError)) throw error;
      lastFailure = error;
    }
  }
  throw new Error(`integration agent did not complete for group ${input.groupId} after ${MAX_ITERATIONS} iterations`, { cause: lastFailure });
}
