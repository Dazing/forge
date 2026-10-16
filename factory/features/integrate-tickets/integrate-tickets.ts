import { resolve } from "node:path";
import { MissingAgentHandoffError } from "../../infrastructure/agent-runtime/handoff.js";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { CommandFailedError, currentBranch, requireNoUnmergedEntries, runGit } from "../../infrastructure/git-provider/git.js";
import type { AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import { integrateHandoff, type IntegrateStageResult } from "./integrate-schema.js";

const MAX_ITERATIONS = 3;

export interface IntegrateTicketsInput {
  readonly groupId: string;
  readonly attemptId: string;
  readonly workspacePath: string;
  readonly branch: string;
  readonly includedTickets: readonly Readonly<{ id: string; title: string; checkpointSha: string; summary: string }>[];
  readonly conflictPaths: readonly string[];
  readonly task: "resolve-and-review" | "combined-review";
  readonly harness: AgentHarness;
  readonly runAgent: AgentRunner;
  /** Called before every repair run; throws when the authority that authorized this work has withdrawn it. */
  authorize?: (stage: string) => Promise<void>;
}

export type IntegrateTicketsOutcome = Readonly<{
  message: string;
  conflicts: readonly Readonly<{ path: string; disposition: string }>[];
  head: string;
  logReference: string;
}>;

export async function integrateTickets(input: IntegrateTicketsInput): Promise<IntegrateTicketsOutcome> {
  const head = (await runGit(input.workspacePath, ["rev-parse", "HEAD"], "reading integration entry HEAD")).trim();
  if (await currentBranch(input.workspacePath) !== input.branch) throw new Error(`Integration workspace must remain on ${input.branch}.`);
  let lastFailure: unknown = new Error("integration agent produced no result");
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    await input.authorize?.(`integration run ${iteration} for group ${input.groupId}`);
    try {
      const result = await input.runAgent<IntegrateStageResult>({
        cwd: input.workspacePath,
        harness: input.harness,
        name: `integrate-${input.groupId}`,
        logTarget: { scope: "attempt", attemptId: input.attemptId, stage: "integrate" },
        promptFile: resolve(import.meta.dirname, "integrate-prompt.md"),
        promptArgs: {
          GROUP_ID: input.groupId,
          BRANCH: input.branch,
          TASK: input.task,
          TICKETS: input.includedTickets.map((ticket) => `${ticket.id} (${ticket.checkpointSha}) ${ticket.title}: ${ticket.summary}`).join("\n"),
          CONFLICT_PATHS: input.conflictPaths.join("\n") || "none",
        },
        handoff: integrateHandoff,
        maxIterations: 1,
      });
      const handoff = result.handoff;
      if (await currentBranch(input.workspacePath) !== input.branch) throw new Error(`Integration agent changed branch from ${input.branch}.`);
      if ((await runGit(input.workspacePath, ["rev-parse", "HEAD"], "checking integration HEAD")).trim() !== head) throw new Error("Integration agent created or changed a commit; only the runner may commit.");
      await requireNoUnmergedEntries(input.workspacePath, "integration completion");
      const dispositionPaths = new Set(handoff.conflicts.map((conflict) => conflict.path));
      const missingDispositions = input.conflictPaths.filter((path) => !dispositionPaths.has(path));
      if (missingDispositions.length > 0) throw new Error(`Integration omitted conflict dispositions for: ${missingDispositions.join(", ")}.`);
      let tracked = "";
      try {
        tracked = await runGit(input.workspacePath, ["grep", "-n", "-E", "^(<<<<<<<|=======|>>>>>>>)", "--", "."], "checking conflict markers");
      } catch (error) {
        if (!(error instanceof CommandFailedError) || error.failure.exitCode !== 1) throw error;
      }
      if (tracked.trim().length > 0) throw new Error(`Integration left conflict markers:\n${tracked.trim()}`);
      return { message: handoff.message, conflicts: handoff.conflicts, head, logReference: result.logReference };
    } catch (error) {
      if (!(error instanceof MissingAgentHandoffError)) throw error;
      lastFailure = error;
    }
  }
  throw new Error(`integration agent did not complete for group ${input.groupId} after ${MAX_ITERATIONS} iterations`, { cause: lastFailure });
}
