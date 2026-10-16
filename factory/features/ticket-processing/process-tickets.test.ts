import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCommand } from "../../infrastructure/git-provider/git.js";
import { InvocationLogger } from "../../infrastructure/logging/invocation-log.js";
import { createGitProviderRegistry } from "../../infrastructure/git-provider/create-git-provider.js";
import type { AgentRunRequest, AgentRunResult, AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";

import { processTickets, type ProcessConfig } from "./index.js";
import { BacklogWorkflow } from "./backlog-workflow.js";
import { PublicationLedger } from "./publication-ledger.js";
import { TEST_GITHUB_TOKEN, TestBacklog } from "./test-backlog.js";

// The daemon loop: an empty planner selection replans immediately, and an empty runnable queue polls
// for ten seconds before rediscovering the board. Every ticket is a backlog issue with a board status.
// Fixture factories need a commit identity; the runner's own checkpoint commits use runGitAsRunner.
process.env.GIT_AUTHOR_NAME = "Daemon Test";
process.env.GIT_AUTHOR_EMAIL = "daemon@test.example";
process.env.GIT_COMMITTER_NAME = "Daemon Test";
process.env.GIT_COMMITTER_EMAIL = "daemon@test.example";

async function daemonConfig(factoryRoot: string, backlog: TestBacklog, runAgent: AgentRunner): Promise<ProcessConfig> {
  const providers = createGitProviderRegistry({ GITHUB_TOKEN: TEST_GITHUB_TOKEN });
  const ledger = PublicationLedger.open(factoryRoot);
  return {
    factoryRoot,
    harness: "pi",
    logger: await InvocationLogger.create(factoryRoot, [...providers.secrets, ...backlog.secrets]),
    providers,
    backlog,
    workflow: new BacklogWorkflow(backlog, ledger),
    ledger,
    runAgent,
    maxParallel: 1,
    ticketAttemptsPerCycle: 3,
  };
}

async function initFactory(root: string, name: string): Promise<string> {
  const factoryRoot = join(root, name);
  await runCommand("git", ["init", "-b", "main", factoryRoot], "initializing daemon factory");
  await runCommand("git", ["commit", "--allow-empty", "-m", "factory"], "committing daemon factory", factoryRoot);
  return factoryRoot;
}

test("the daemon replans without sleeping when an empty selection leaves active work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-daemon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const factoryRoot = await initFactory(root, "factory");
  const backlog = new TestBacklog();
  backlog.seed({ id: "active", number: 1, status: "Ready for development" });
  const stop = new Error("bounded daemon stop");
  let plans = 0;
  const runAgent: AgentRunner = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    if (++plans === 2) throw stop;
    return { iterations: [], commits: [], stdout: "", branch: "", logReference: `planner/${String(plans).padStart(3, "0")}.log`, handoff: { groups: [] } as TOutput } as unknown as AgentRunResult<TOutput>;
  };
  const config = await daemonConfig(factoryRoot, backlog, runAgent);
  t.mock.method(console, "error", () => undefined);
  t.mock.method(console, "log", () => undefined);
  t.mock.method(globalThis, "setTimeout", () => {
    throw new Error("polling must not sleep while a ticket remains active");
  });
  await assert.rejects(processTickets(config), (error: unknown) => error === stop);
  assert.equal(plans, 2);
});

test("the daemon polls and discovers a new ticket when every current ticket is blocked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-blocked-daemon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const factoryRoot = await initFactory(root, "factory");
  const backlog = new TestBacklog();
  backlog.seed({ id: "blocked", number: 1, status: "Blocked" });
  const stop = new Error("new ticket reached planner");
  let plans = 0;
  const runAgent: AgentRunner = async () => {
    plans++;
    throw stop;
  };
  const config = await daemonConfig(factoryRoot, backlog, runAgent);
  const delays: number[] = [];
  t.mock.method(console, "error", () => undefined);
  t.mock.method(console, "log", () => undefined);
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    backlog.seed({ id: "fresh", number: 2, status: "Ready for development" });
    callback();
    return 0 as unknown as NodeJS.Timeout;
  });

  await assert.rejects(processTickets(config), (error: unknown) => error === stop);

  assert.deepEqual(delays, [10_000]);
  assert.equal(plans, 1);
});
