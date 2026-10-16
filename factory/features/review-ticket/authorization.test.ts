import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitAsRunner } from "../../infrastructure/git-provider/git.js";
import type { AgentRunRequest, AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { reviewTicket } from "./review-ticket.js";
import { parseTicketSource } from "../tickets/index.js";
import { createGitProviderRegistry } from "../../infrastructure/git-provider/create-git-provider.js";

// The review loop re-checks authorization before each of its three runs and propagates withdrawal
// unwrapped, so the coordinator can preserve the workspace instead of checkpointing reviewed work.

const providers = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc" });
const ticket = parseTicketSource("---\nid: ABC-2\nname: Review Login\nrepository: git@github.com:acme/widgets.git\n---\n# Review retry\n\nBody.", providers, "https://github.com/acme/backlog/issues/13");
const BRANCH = "factory/ABC-2";

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "review-guard-"));
  await writeFile(join(path, "base.txt"), "base\n", "utf8");
  await runGitAsRunner(path, ["init", "-b", BRANCH], "init");
  await runGitAsRunner(path, ["add", "--all"], "add");
  await runGitAsRunner(path, ["commit", "-m", "implementation checkpoint"], "commit");
  return path;
}

const reviewer: AgentRunner = async <T>(request: AgentRunRequest<T>) =>
  ({ handoff: { message: "reviewed" } as T, logReference: "attempt-a/review-1.log", iterations: [], stdout: "", commits: [], branch: "" }) as unknown as AgentRunResult<T>;

test("review refuses to dispatch an agent once authorization is withdrawn", async (t) => {
  const workspacePath = await workspace();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const withdrawn = new Error("authorization withdrawn: backlog issue #13 is no longer open");
  const observed: string[] = [];
  let agentRuns = 0;
  await assert.rejects(
    reviewTicket({
      ticket,
      workspacePath,
      branch: BRANCH,
      attemptId: "attempt-a",
      harness: "pi",
      runAgent: async (request) => {
        agentRuns += 1;
        return reviewer(request);
      },
      authorize: async (stage) => {
        observed.push(stage);
        throw withdrawn;
      },
    }),
    (error: unknown) => error === withdrawn,
  );
  assert.deepEqual(observed, ["review run 1 for ticket ABC-2"]);
  assert.equal(agentRuns, 0);
});

test("review dispatches while the board keeps authorizing the work", async (t) => {
  const workspacePath = await workspace();
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const observed: string[] = [];
  const outcome = await reviewTicket({
    ticket,
    workspacePath,
    branch: BRANCH,
    attemptId: "attempt-a",
    harness: "pi",
    runAgent: reviewer,
    authorize: async (stage) => {
      observed.push(stage);
    },
  });
  assert.equal(outcome.message, "reviewed");
  assert.deepEqual(observed, ["review run 1 for ticket ABC-2"]);
});
