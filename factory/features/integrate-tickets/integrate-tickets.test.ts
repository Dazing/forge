import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRunRequest, AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { AgentHandoffTransportError, MissingAgentHandoffError } from "../../infrastructure/agent-runtime/handoff.js";
import { runCommand } from "../../infrastructure/git-provider/git.js";
import { integrateTickets, type IntegrateTicketsInput } from "./integrate-tickets.js";

const BRANCH = "agent-tickets/integration";

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sandcastle-integrate-"));
  await runCommand("git", ["init", "-b", BRANCH, path], "initializing integration workspace");
  await runCommand("git", ["-C", path, "-c", "user.name=Integration", "-c", "user.email=integration@test", "commit", "--allow-empty", "-m", "base"], "committing integration base");
  return path;
}

function input(workspacePath: string, runAgent: AgentRunner): IntegrateTicketsInput {
  return {
    groupId: "group-a",
    workspacePath,
    branch: BRANCH,
    includedTickets: [{ id: "a", title: "A", checkpointSha: "abc", summary: "implemented" }],
    conflictPaths: [],
    task: "combined-review",
    harness: "pi",
    runAgent,
  };
}

test("integration returns one accepted stage-shaped handoff", async () => {
  const workspacePath = await workspace();
  const requests: AgentRunRequest<unknown>[] = [];
  const runAgent: AgentRunner = async <THandoff>(request: AgentRunRequest<THandoff>) => {
    requests.push(request);
    return { iterations: [], commits: [], stdout: "", branch: BRANCH, handoff: { message: "chore(integration): reviewed", conflicts: [] } as THandoff } as AgentRunResult<THandoff>;
  };

  const outcome = await integrateTickets(input(workspacePath, runAgent));

  assert.equal(outcome.message, "chore(integration): reviewed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.handoff.toolName, "submit_handoff");
  assert.deepEqual(requests[0]?.handoff.inputSchema.required, ["message", "conflicts"]);
});

test("integration retries only missing handoffs", async () => {
  const missingWorkspace = await workspace();
  let missingRuns = 0;
  const missing: AgentRunner = async () => {
    missingRuns++;
    throw new MissingAgentHandoffError();
  };
  await assert.rejects(integrateTickets(input(missingWorkspace, missing)), /did not complete/);
  assert.equal(missingRuns, 3);

  const transportWorkspace = await workspace();
  let transportRuns = 0;
  const transport: AgentRunner = async () => {
    transportRuns++;
    throw new AgentHandoffTransportError("transport failed");
  };
  await assert.rejects(integrateTickets(input(transportWorkspace, transport)), /transport failed/);
  assert.equal(transportRuns, 1);
});
