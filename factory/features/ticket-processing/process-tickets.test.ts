import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { runCommand, runGit } from "../../infrastructure/git-provider/git.js";
import type { GitProvider } from "../../infrastructure/git-provider/git-provider.js";
import { InvocationLogger } from "../../infrastructure/logging/invocation-log.js";
import { processTickets } from "./process-tickets.js";
import type { ProcessConfig } from "./process-config.js";

process.env.GIT_AUTHOR_NAME = "Daemon Test";
process.env.GIT_AUTHOR_EMAIL = "daemon@test.example";
process.env.GIT_COMMITTER_NAME = "Daemon Test";
process.env.GIT_COMMITTER_EMAIL = "daemon@test.example";

test("the daemon replans without sleeping when an empty selection leaves active work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-daemon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const factoryRoot = join(root, "factory");
  const ticketsDir = join(factoryRoot, "tickets");
  await mkdir(ticketsDir, { recursive: true });
  await runCommand("git", ["init", "-b", "main", factoryRoot], "initializing daemon factory");
  await writeFile(join(factoryRoot, "README.md"), "factory\n");
  await runGit(factoryRoot, ["add", "README.md"], "staging daemon factory");
  await runGit(factoryRoot, ["commit", "-m", "factory"], "committing daemon factory");
  const repository = "git@github.com:acme/app.git";
  await writeFile(join(ticketsDir, "active.md"), `---\nid: active\nname: Active\nrepository: ${repository}\n---\n\n# Active\n`);
  const stop = new Error("bounded daemon stop");
  let plans = 0;
  const runAgent: AgentRunner = async <TOutput>() => {
    if (++plans === 2) throw stop;
    return { iterations: [], commits: [], stdout: "", branch: "", completionSignal: "</plan>", output: { groups: [] } as TOutput } as AgentRunResult<TOutput>;
  };
  const provider: GitProvider = {
    name: "github",
    credential: "secret",
    mergeStrategySupport: "unsupported",
    validateRepository: (url) => { if (url !== repository) throw new Error("unexpected repository"); },
    createDraftPullRequest: async () => ({ number: 1, url: "https://example.test/pr/1", squashPreference: "unsupported" }),
    secrets: () => ["secret"],
  };
  const config: ProcessConfig = {
    ticketsDir,
    factoryRoot,
    harness: "pi",
    logger: await InvocationLogger.create(factoryRoot, provider.credential),
    gitProvider: provider,
    runAgent,
    maxParallel: 1,
    ticketAttemptsPerCycle: 3,
  };
  t.mock.method(globalThis, "setTimeout", () => { throw new Error("polling must not sleep while a ticket remains active"); });
  await assert.rejects(processTickets(config), (error: unknown) => error === stop);
  assert.equal(plans, 2);
});

test("the daemon polls and discovers a new ticket when every current ticket is blocked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-blocked-daemon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const factoryRoot = join(root, "factory");
  const ticketsDir = join(factoryRoot, "tickets");
  await mkdir(ticketsDir, { recursive: true });
  await runCommand("git", ["init", "-b", "main", factoryRoot], "initializing blocked daemon factory");
  await writeFile(join(factoryRoot, "README.md"), "factory\n");
  await runGit(factoryRoot, ["add", "README.md"], "staging blocked daemon factory");
  await runGit(factoryRoot, ["commit", "-m", "factory"], "committing blocked daemon factory");
  const repository = "git@github.com:acme/app.git";
  await writeFile(
    join(ticketsDir, "blocked.md"),
    `---\nid: blocked\nname: Blocked\nrepository: ${repository}\n---\n\n# Blocked\n\n## Attempt abc123 (2026-10-11T00:00:00.000Z)\n\n- Workspace: \`/retained/blocked-abc123\`\n`,
  );
  const stop = new Error("new ticket reached planner");
  let plans = 0;
  const runAgent: AgentRunner = async () => {
    plans++;
    throw stop;
  };
  const provider: GitProvider = {
    name: "github",
    credential: "secret",
    mergeStrategySupport: "unsupported",
    validateRepository: (url) => { if (url !== repository) throw new Error("unexpected repository"); },
    createDraftPullRequest: async () => ({ number: 1, url: "https://example.test/pr/1", squashPreference: "unsupported" }),
    secrets: () => ["secret"],
  };
  const config: ProcessConfig = {
    ticketsDir,
    factoryRoot,
    harness: "pi",
    logger: await InvocationLogger.create(factoryRoot, provider.credential),
    gitProvider: provider,
    runAgent,
    maxParallel: 1,
    ticketAttemptsPerCycle: 3,
  };
  const delays: number[] = [];
  t.mock.method(console, "error", () => undefined);
  t.mock.method(console, "log", () => undefined);
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    writeFileSync(
      join(ticketsDir, "fresh.md"),
      `---\nid: fresh\nname: Fresh\nrepository: ${repository}\n---\n\n# Fresh\n`,
    );
    callback();
    return 0 as unknown as NodeJS.Timeout;
  });

  await assert.rejects(processTickets(config), (error: unknown) => error === stop);

  assert.deepEqual(delays, [10_000]);
  assert.equal(plans, 1);
});
