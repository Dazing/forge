import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitAsRunner } from "../../infrastructure/git-provider/git.js";
import type { AgentRunRequest, AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { implementTicket } from "./implement-ticket.js";
import { parseTicketSource } from "../tickets/index.js";
import { createGitProviderRegistry } from "../../infrastructure/git-provider/create-git-provider.js";

// Authorization is re-checked at every side-effect boundary: the implementation loop must stop before
// dispatching an agent, propagate the withdrawal unwrapped, and leave the workspace untouched. The
// coordinator owns the guard; this stage only honors the callback it is handed.

const providers = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc" });
const ticket = parseTicketSource("---\nid: ABC-1\nname: Fix Login\nrepository: git@github.com:acme/widgets.git\n---\n# Add retry\n\nBody.", providers, "https://github.com/acme/backlog/issues/12");

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "implement-guard-"));
  await writeFile(join(path, "base.txt"), "base\n", "utf8");
  await runGitAsRunner(path, ["init", "-b", "main"], "init");
  await runGitAsRunner(path, ["add", "--all"], "add");
  await runGitAsRunner(path, ["commit", "-m", "base"], "commit");
  await runGitAsRunner(path, ["checkout", "-b", "factory/ABC-1"], "branch");
  return path;
}

const runner: AgentRunner = async <T>(request: AgentRunRequest<T>) => {
  return { handoff: { message: "done" } as T, logReference: "attempt-a/implement-1.log", iterations: [], stdout: "", commits: [], branch: "" } as unknown as AgentRunResult<T>;
};

test("implementation refuses to dispatch an agent once authorization is withdrawn", async (t) => {
  const workspacePath = await workspace();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const withdrawn = new Error("authorization withdrawn: its Project status is Blocked, not In progress");
  const observed: string[] = [];
  let agentRuns = 0;
  await assert.rejects(
    implementTicket({
      ticket,
      workspacePath,
      branch: "factory/ABC-1",
      attemptId: "attempt-a",
      harness: "pi",
      runAgent: async (request) => {
        agentRuns += 1;
        return runner(request);
      },
      authorize: async (stage) => {
        observed.push(stage);
        throw withdrawn;
      },
    }),
    (error: unknown) => error === withdrawn,
  );
  assert.deepEqual(observed, ["implementation run 1 for ticket ABC-1"]);
  assert.equal(agentRuns, 0);
  assert.equal((await runGitAsRunner(workspacePath, ["status", "--porcelain"], "status")).trim(), "");
});

test("implementation dispatches every iteration while authorization holds", async (t) => {
  const workspacePath = await workspace();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const observed: string[] = [];
  await implementTicket({
    ticket,
    workspacePath,
    branch: "factory/ABC-1",
    attemptId: "attempt-a",
    harness: "pi",
    runAgent: runner,
    authorize: async (stage) => {
      observed.push(stage);
    },
  });
  assert.deepEqual(observed, ["implementation run 1 for ticket ABC-1"]);
});
