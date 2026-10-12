import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { MissingAgentHandoffError } from "../../infrastructure/agent-runtime/handoff.js";
import { runCommand, runGit } from "../../infrastructure/git-provider/git.js";
import { validateGroupPlan, type PlannedGroup } from "./group-plan-schema.js";
import { planGroups } from "./plan-tickets.js";

process.env.GIT_AUTHOR_NAME = "Group Planner Test";
process.env.GIT_AUTHOR_EMAIL = "planner@test.example";
process.env.GIT_COMMITTER_NAME = "Group Planner Test";
process.env.GIT_COMMITTER_EMAIL = "planner@test.example";

const group: PlannedGroup = { groupId: "group-a", tickets: [{ id: "a", title: "A" }, { id: "b", title: "B" }] };

test("group validation accepts only exact IDs, ordered membership, and titles", () => {
  const available = new Map([[group.groupId, group]]);
  assert.deepEqual(validateGroupPlan([group], available), [group]);
  assert.throws(() => validateGroupPlan([{ ...group, groupId: "unknown" }], available), /unknown delivery group/);
  assert.throws(() => validateGroupPlan([{ ...group, tickets: [...group.tickets].reverse() }], available), /changed membership or titles/);
  assert.throws(() => validateGroupPlan([group, group], available), /more than once/);
});

async function factoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-group-plan-"));
  await runCommand("git", ["init", "-b", "main", root], "initializing planner fixture");
  await writeFile(join(root, "README.md"), "factory\n");
  await runGit(root, ["add", "README.md"], "staging planner fixture");
  await runGit(root, ["commit", "-m", "factory"], "committing planner fixture");
  return root;
}

test("group planning returns validated output and preserves the factory checkout", async () => {
  const factoryRoot = await factoryFixture();
  const runAgent: AgentRunner = async <TOutput>() => ({
    iterations: [], commits: [], stdout: "", branch: "", handoff: { groups: [group] } as TOutput,
  } as AgentRunResult<TOutput>);
  assert.deepEqual(await planGroups({ groups: [group], factoryRoot, harness: "pi", runAgent, runId: "1" }), [group]);
});

test("group planning rejects factory mutations", async () => {
  const factoryRoot = await factoryFixture();
  const runAgent: AgentRunner = async <TOutput>() => {
    await writeFile(join(factoryRoot, "unexpected.txt"), "mutation\n");
    return { iterations: [], commits: [], stdout: "", branch: "", handoff: { groups: [] } as TOutput } as AgentRunResult<TOutput>;
  };
  await assert.rejects(planGroups({ groups: [group], factoryRoot, harness: "pi", runAgent, runId: "1" }), /planning stage changed factory/);
});

test("group planning distinguishes an accepted empty selection from a missing handoff", async () => {
  const factoryRoot = await factoryFixture();
  const empty: AgentRunner = async <TOutput>() => ({
    iterations: [], commits: [], stdout: "", branch: "", handoff: { groups: [] } as TOutput,
  } as AgentRunResult<TOutput>);
  assert.deepEqual(await planGroups({ groups: [group], factoryRoot, harness: "pi", runAgent: empty, runId: "1" }), []);

  const missing: AgentRunner = async () => {
    throw new MissingAgentHandoffError();
  };
  await assert.rejects(
    planGroups({ groups: [group], factoryRoot, harness: "pi", runAgent: missing, runId: "2" }),
    { name: "MissingAgentHandoffError" },
  );
});
