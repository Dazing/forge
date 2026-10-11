import { Output } from "@ai-hero/sandcastle";
import { resolve } from "node:path";
import { requireUnchanged, snapshotRepository } from "../../infrastructure/git-provider/git.js";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import type { AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import { groupPlanSchema, validateGroupPlan, type PlannedGroup } from "./group-plan-schema.js";

// Planning iteration: run the read-only planner from the factory checkout, validate the selection,
// and require the factory HEAD and porcelain status to be unchanged around the planner run.

export interface PlanGroupsInput {
  readonly groups: readonly PlannedGroup[];
  readonly factoryRoot: string;
  readonly harness: AgentHarness;
  readonly runAgent: AgentRunner;
  readonly runId: string;
}


export async function planGroups(input: PlanGroupsInput): Promise<PlannedGroup[]> {
  const factoryBefore = await snapshotRepository(input.factoryRoot);
  const result = await input.runAgent({
    cwd: input.factoryRoot,
    harness: input.harness,
    name: `plan-groups-${input.runId}`,
    logName: `plan-groups-${input.runId}`,
    promptFile: resolve(import.meta.dirname, "group-plan-prompt.md"),
    promptArgs: { GROUPS: input.groups.map((group) => `<group id="${group.groupId}">\n${group.tickets.map((ticket) => `- ${ticket.id}: ${ticket.title}`).join("\n")}\n</group>`).join("\n\n") },
    completionSignal: "</plan>",
    output: Output.object({ tag: "plan", schema: groupPlanSchema }),
  });
  if (result.completionSignal !== "</plan>") throw new Error("planner did not complete");
  const planned = validateGroupPlan(result.output.groups, new Map(input.groups.map((group) => [group.groupId, group])));
  requireUnchanged("planning stage", "factory", factoryBefore, await snapshotRepository(input.factoryRoot));
  return planned;
}
