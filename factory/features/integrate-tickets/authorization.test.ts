import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitAsRunner } from "../../infrastructure/git-provider/git.js";
import type { AgentRunRequest, AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { integrateTickets } from "./integrate-tickets.js";

// Integration is the last gate before a group publication, so its repair loop is guarded too: a
// withdrawn member stops the run before any agent touches the combined workspace.

const BRANCH = "factory/group-1";

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "integrate-guard-"));
  await writeFile(join(path, "base.txt"), "base\n", "utf8");
  await runGitAsRunner(path, ["init", "-b", BRANCH], "init");
  await runGitAsRunner(path, ["add", "--all"], "add");
  await runGitAsRunner(path, ["commit", "-m", "integration entry"], "commit");
  return path;
}

const integrator: AgentRunner = async <T>(request: AgentRunRequest<T>) =>
  ({ handoff: { message: "combined review passed", conflicts: [] } as T, logReference: "attempt-a/integrate-1.log", iterations: [], stdout: "", commits: [], branch: "" }) as unknown as AgentRunResult<T>;

function baseInput(workspacePath: string, runAgent: AgentRunner) {
  return {
    groupId: "group-1",
    attemptId: "attempt-a",
    workspacePath,
    branch: BRANCH,
    includedTickets: [{ id: "ABC-1", title: "Fix Login", checkpointSha: "0".repeat(40), summary: "retry" }],
    conflictPaths: [],
    task: "combined-review" as const,
    harness: "pi" as const,
    runAgent,
  };
}

test("integration refuses to dispatch a repair run once authorization is withdrawn", async (t) => {
  const workspacePath = await workspace();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const withdrawn = new Error("authorization withdrawn: its Project status is Blocked, not In progress");
  const observed: string[] = [];
  let agentRuns = 0;
  await assert.rejects(
    integrateTickets({
      ...baseInput(workspacePath, async (request) => {
        agentRuns += 1;
        return integrator(request);
      }),
      authorize: async (stage) => {
        observed.push(stage);
        throw withdrawn;
      },
    }),
    (error: unknown) => error === withdrawn,
  );
  assert.deepEqual(observed, ["integration run 1 for group group-1"]);
  assert.equal(agentRuns, 0);
});

test("integration dispatches the combined review while authorization holds", async (t) => {
  const workspacePath = await workspace();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const observed: string[] = [];
  const outcome = await integrateTickets({
    ...baseInput(workspacePath, integrator),
    authorize: async (stage) => {
      observed.push(stage);
    },
  });
  assert.equal(outcome.message, "combined review passed");
  assert.deepEqual(observed, ["integration run 1 for group group-1"]);
});
