import { access, chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRequest, AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { MissingAgentHandoffError } from "../../infrastructure/agent-runtime/handoff.js";
import { runCommand, runGit } from "../../infrastructure/git-provider/git.js";
import type { DraftPullRequestRequest, GitProvider, PullRequestDetails, UpdateDraftPullRequestRequest } from "../../infrastructure/git-provider/git-provider.js";
import { InvocationLogger } from "../../infrastructure/logging/invocation-log.js";
import { createDependencyWorkflowState, processDependencyCycle } from "./dependency-cycle.js";
import { JobLimiter } from "./job-limiter.js";
import type { ProcessConfig } from "./process-config.js";

process.env.GIT_AUTHOR_NAME = "Dependency Test";
process.env.GIT_AUTHOR_EMAIL = "dependency@test.example";
process.env.GIT_COMMITTER_NAME = "Dependency Test";
process.env.GIT_COMMITTER_EMAIL = "dependency@test.example";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-dependencies-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const factoryRoot = join(root, "factory");
  const ticketsDir = join(factoryRoot, "tickets");
  await runCommand("git", ["init", "--bare", remote], "creating remote");
  await runCommand("git", ["clone", remote, seed], "cloning seed");
  await runGit(seed, ["checkout", "-B", "main"], "creating main");
  await writeFile(join(seed, "README.md"), "# app\n");
  await runGit(seed, ["add", "README.md"], "staging seed");
  await runGit(seed, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], "committing seed");
  await runGit(seed, ["push", "origin", "main"], "pushing seed");
  await runCommand("git", ["init", "-b", "main", factoryRoot], "creating factory");
  await writeFile(join(factoryRoot, "README.md"), "factory\n");
  await writeFile(join(factoryRoot, ".gitignore"), ".logs/\n.workspaces/\n");
  await runGit(factoryRoot, ["add", "README.md", ".gitignore"], "staging factory");
  await runGit(factoryRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "factory"], "committing factory");
  await mkdir(ticketsDir);
  return { root, remote, factoryRoot, ticketsDir };
}

function markdown(id: string, remote: string, dependencies: readonly string[]) {
  return `---\nid: ${id}\nname: ${id}\nrepository: ${remote}\ndependsOnTickets: [${dependencies.join(", ")}]\n---\n# ${id}\n\nImplement ${id}.\n`;
}

/** Mimics the runtime: every run for one attempt and stage gets the next numbered transcript inside that attempt's directory. */
function transcriptFor(request: AgentRunRequest<unknown>): string {
  const target = request.logTarget;
  if (target.scope === "sequence") return `planner/${String(target.cycle).padStart(3, "0")}.log`;
  const key = `${target.attemptId}/${target.stage}`;
  const number = (RUNS.get(key) ?? 0) + 1;
  RUNS.set(key, number);
  return `${target.attemptId}/${target.stage}-${number}.log`;
}
const RUNS = new Map<string, number>();

test("diamond dependencies use isolated sibling baselines, bounded overlap, reviewed integration, and one group publication", async () => {
  const { remote, factoryRoot, ticketsDir } = await fixture();
  for (const [id, dependencies] of [["a", []], ["b", ["a"]], ["c", ["a"]], ["d", ["b", "c"]]] as const) {
    await writeFile(join(ticketsDir, `${id}.md`), markdown(id, remote, dependencies));
  }
  let activeImplementations = 0;
  const siblingBarrier = Promise.withResolvers<void>();
  let maxActiveImplementations = 0;
  const baselines = new Map<string, string[]>();
  const runAgent: AgentRunner = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    const base = { iterations: [], commits: [], stdout: "", branch: "" };
    if (request.name.startsWith("plan-groups-")) {
      const groupsText = request.promptArgs.GROUPS!;
      const groupId = /<group id="([^"]+)">/.exec(groupsText)![1]!;
      const tickets = [...groupsText.matchAll(/- ([^:]+): (.+)/g)].map((match) => ({ id: match[1]!, title: match[2]! }));
      return { ...base, logReference: transcriptFor(request), handoff: { groups: [{ groupId, tickets }] } } as unknown as AgentRunResult<TOutput>;
    }
    if (request.name.startsWith("implement-")) {
      const id = request.promptArgs.TICKET_ID!;
      baselines.set(id, (await runGit(request.cwd, ["ls-tree", "--name-only", "HEAD"], "reading attempt baseline")).split("\n").filter(Boolean));
      activeImplementations++;
      maxActiveImplementations = Math.max(maxActiveImplementations, activeImplementations);
      if (id === "b" || id === "c") {
        if (activeImplementations === 2) siblingBarrier.resolve();
        await siblingBarrier.promise;
      }
      await writeFile(join(request.cwd, `${id}.txt`), `${id}\n`);
      if (id === "b" || id === "c") await writeFile(join(request.cwd, "shared.txt"), `${id}\n`);
      activeImplementations--;
      return { ...base, logReference: transcriptFor(request), handoff: { message: `feat(${id}): implement ${id}` } } as unknown as AgentRunResult<TOutput>;
    }
    if (request.name.startsWith("review-")) return { ...base, logReference: transcriptFor(request), handoff: { message: "chore(review): verify combined behavior" } } as unknown as AgentRunResult<TOutput>;
    if (request.name.startsWith("integrate-")) {
      const conflicts = request.promptArgs.CONFLICT_PATHS === "none" ? [] : request.promptArgs.CONFLICT_PATHS!.split("\n");
      if (conflicts.includes("shared.txt")) {
        await writeFile(join(request.cwd, "shared.txt"), "b\nc\n");
        await runGit(request.cwd, ["add", "shared.txt"], "resolving integration fixture conflict");
      }
      return { ...base, logReference: transcriptFor(request), handoff: { message: "chore(integration): review combined behavior", conflicts: conflicts.map((path) => ({ path, disposition: "combined" })) } } as unknown as AgentRunResult<TOutput>;
    }
    return { ...base, logReference: transcriptFor(request), handoff: { title: "Deliver dependency group", body: "Reviewed as one dependency group." } } as unknown as AgentRunResult<TOutput>;
  };
  const requests: DraftPullRequestRequest[] = [];
  const provider: GitProvider = {
    name: "github",
    credential: "secret",
    mergeStrategySupport: "unsupported",
    validateRepository: (url) => { if (url !== remote) throw new Error("unexpected repository"); },
    createDraftPullRequest: async (request) => { requests.push(request); return { number: 1, url: "https://example.test/pr/1", squashPreference: "unsupported" }; },
    secrets: () => ["secret"],
  };
  const limiter = new JobLimiter(2);
  const config: ProcessConfig = {
    ticketsDir,
    factoryRoot,
    harness: "pi",
    logger: await InvocationLogger.create(factoryRoot, provider.credential),
    gitProvider: provider,
    runAgent: limiter.wrap(runAgent),
    maxParallel: 2,
    ticketAttemptsPerCycle: 2,
  };

  const state = createDependencyWorkflowState();
  await processDependencyCycle(config, state);

  assert.equal(maxActiveImplementations, 2, JSON.stringify({ reviewed: [...state.reviewed.keys()], blocked: [...state.blocked] }));
  assert.deepEqual(baselines.get("b"), ["README.md", "a.txt"]);
  assert.deepEqual(baselines.get("c"), ["README.md", "a.txt"]);
  assert.deepEqual(baselines.get("d"), ["README.md", "a.txt", "b.txt", "c.txt", "shared.txt"]);
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.body, /Included: a \(a\), b \(b\), c \(c\), d \(d\)/);
  assert.match(requests[0]!.body, /shared\.txt: combined/);
  for (const id of ["a", "b", "c", "d"]) assert.match(await readFile(join(ticketsDir, "done", `${id}.md`), "utf8"), /Group publication/);
});

test("an exhausted ticket publishes reviewed ancestors, blocks descendants, then retries fresh next cycle", async () => {
  const { remote, factoryRoot, ticketsDir } = await fixture();
  for (const [id, dependencies] of [["a", []], ["b", ["a"]], ["c", ["b"]]] as const) {
    await writeFile(join(ticketsDir, `${id}.md`), markdown(id, remote, dependencies));
  }
  let cycle = 1;
  let bImplementRuns = 0;
  let cImplementRuns = 0;
  const bWorkspaces = new Set<string>();
  let freshRetryWasClean = false;
  const runAgent: AgentRunner = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    const base = { iterations: [], commits: [], stdout: "", branch: "" };
    if (request.name.startsWith("plan-groups-")) {
      const groupsText = request.promptArgs.GROUPS!;
      const groupId = /<group id="([^"]+)">/.exec(groupsText)![1]!;
      const tickets = [...groupsText.matchAll(/- ([^:]+): (.+)/g)].map((match) => ({ id: match[1]!, title: match[2]! }));
      return { ...base, logReference: transcriptFor(request), handoff: { groups: [{ groupId, tickets }] } } as unknown as AgentRunResult<TOutput>;
    }
    if (request.name.startsWith("implement-")) {
      const id = request.promptArgs.TICKET_ID!;
      if (id === "b") {
        bImplementRuns++;
        bWorkspaces.add(request.cwd);
        if (cycle === 1) {
          await writeFile(join(request.cwd, "failed-attempt-sentinel.txt"), "must not leak\n");
          throw new MissingAgentHandoffError();
        }
        await assert.rejects(readFile(join(request.cwd, "failed-attempt-sentinel.txt"), "utf8"), { code: "ENOENT" });
        freshRetryWasClean = true;
      }
      if (id === "c") cImplementRuns++;
      await writeFile(join(request.cwd, `${id}.txt`), `${id}\n`);
      return { ...base, logReference: transcriptFor(request), handoff: { message: `feat(${id}): implement ${id}` } } as unknown as AgentRunResult<TOutput>;
    }
    if (request.name.startsWith("review-")) return { ...base, logReference: transcriptFor(request), handoff: { message: "chore(review): verify behavior" } } as unknown as AgentRunResult<TOutput>;
    if (request.name.startsWith("integrate-")) return { ...base, logReference: transcriptFor(request), handoff: { message: "chore(integration): verify group", conflicts: [] } } as unknown as AgentRunResult<TOutput>;
    return { ...base, logReference: transcriptFor(request), handoff: { title: `Cycle ${cycle}`, body: `Cycle ${cycle} delivery.` } } as unknown as AgentRunResult<TOutput>;
  };
  const requests: DraftPullRequestRequest[] = [];
  const updates: UpdateDraftPullRequestRequest[] = [];
  let pullRequest: PullRequestDetails | undefined;
  const provider: GitProvider = {
    name: "github",
    credential: "secret",
    mergeStrategySupport: "unsupported",
    validateRepository: (url) => { if (url !== remote) throw new Error("unexpected repository"); },
    createDraftPullRequest: async (request) => {
      requests.push(request);
      const sourceSha = (await runCommand("git", ["--git-dir", remote, "rev-parse", `refs/heads/${request.head}`], "reading published test branch")).trim();
      pullRequest = { number: 1, url: "https://example.test/pr/1", state: "open", draft: true, head: request.head, base: request.base, sourceSha, title: request.title, body: request.body, squashPreference: "unsupported" };
      return { number: 1, url: pullRequest.url, squashPreference: "unsupported" };
    },
    getPullRequest: async () => pullRequest,
    updateDraftPullRequest: async (request) => {
      updates.push(request);
      pullRequest = { ...pullRequest!, sourceSha: request.expectedSourceSha, title: request.title, body: request.body };
      return { number: 1, url: pullRequest.url, squashPreference: "unsupported" };
    },
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
    ticketAttemptsPerCycle: 1,
  };
  const state = createDependencyWorkflowState();

  await processDependencyCycle(config, state);
  assert.deepEqual([...state.reviewed.keys()], ["a"]);
  assert.equal(cImplementRuns, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.body, /Retryable: b/);
  assert.match(requests[0]!.body, /Blocked: c/);

  cycle = 2;
  await processDependencyCycle(config, state);
  assert.equal(bImplementRuns, 4);
  assert.equal(bWorkspaces.size, 2);
  assert.equal(freshRetryWasClean, true);
  assert.equal(cImplementRuns, 1);
  assert.deepEqual([...state.reviewed.keys()], ["a", "b", "c"]);
  assert.equal(requests.length, 1);
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.body, /Included: a \(a\), b \(b\), c \(c\)/);
});

test("failed combined review publishes separate reviewed subsets and leaves multi-parent descendants blocked", async () => {
  const { remote, factoryRoot, ticketsDir } = await fixture();
  for (const [id, dependencies] of [["a", []], ["b", ["a"]], ["c", ["a"]], ["d", ["b", "c"]]] as const) {
    await writeFile(join(ticketsDir, `${id}.md`), markdown(id, remote, dependencies));
  }
  let dRuns = 0;
  const runAgent: AgentRunner = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    const base = { iterations: [], commits: [], stdout: "", branch: "" };
    if (request.name.startsWith("plan-groups-")) {
      const groupId = /<group id="([^"]+)">/.exec(request.promptArgs.GROUPS!)![1]!;
      const tickets = [...request.promptArgs.GROUPS!.matchAll(/- ([^:]+): (.+)/g)].map((match) => ({ id: match[1]!, title: match[2]! }));
      return { ...base, logReference: transcriptFor(request), handoff: { groups: [{ groupId, tickets }] } } as unknown as AgentRunResult<TOutput>;
    }
    if (request.name.startsWith("implement-")) {
      const id = request.promptArgs.TICKET_ID!;
      if (id === "d") dRuns++;
      await writeFile(join(request.cwd, `${id}.txt`), `${id}\n`);
      return { ...base, logReference: transcriptFor(request), handoff: { message: `feat(${id}): implement ${id}` } } as unknown as AgentRunResult<TOutput>;
    }
    if (request.name.startsWith("review-")) return { ...base, logReference: transcriptFor(request), handoff: { message: "chore(review): verify ticket" } } as unknown as AgentRunResult<TOutput>;
    if (request.name.startsWith("integrate-")) throw new MissingAgentHandoffError();
    return { ...base, logReference: transcriptFor(request), handoff: { title: "Reviewed subset", body: "A reviewed dependency-closed subset." } } as unknown as AgentRunResult<TOutput>;
  };
  const requests: DraftPullRequestRequest[] = [];
  const provider: GitProvider = {
    name: "github",
    credential: "secret",
    mergeStrategySupport: "unsupported",
    validateRepository: () => {},
    createDraftPullRequest: async (request) => {
      requests.push(request);
      return { number: requests.length, url: `https://example.test/pr/${requests.length}`, squashPreference: "unsupported" };
    },
    secrets: () => ["secret"],
  };
  const config: ProcessConfig = {
    ticketsDir,
    factoryRoot,
    harness: "pi",
    logger: await InvocationLogger.create(factoryRoot, provider.credential),
    gitProvider: provider,
    runAgent,
    maxParallel: 2,
    ticketAttemptsPerCycle: 1,
  };
  const state = createDependencyWorkflowState();

  await processDependencyCycle(config, state);

  assert.equal(dRuns, 0);
  assert.match(state.blocked.get("d")!, /multi-parent integration review failed/);
  assert.equal(requests.length, 2);
  assert.ok(requests.some((request) => /Included: a \(a\), b \(b\)/.test(request.body)));
  assert.ok(requests.some((request) => /Included: a \(a\), c \(c\)/.test(request.body)));
  assert.equal(await readFile(join(ticketsDir, "done", "a.md"), "utf8").then((text) => (text.match(/Group publication/g) ?? []).length), 1);
});

test("checkpoint failures are written to main.log and surfaced on stderr", async (t) => {
  const { remote, factoryRoot, ticketsDir } = await fixture();
  await writeFile(join(ticketsDir, "a.md"), markdown("a", remote, []));
  const runAgent: AgentRunner = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    const base = { iterations: [], commits: [], stdout: "", branch: "" };
    if (request.name.startsWith("plan-groups-")) {
      const groupId = /<group id="([^"]+)">/.exec(request.promptArgs.GROUPS!)![1]!;
      return { ...base, logReference: transcriptFor(request), handoff: { groups: [{ groupId, tickets: [{ id: "a", title: "a" }] }] } } as unknown as AgentRunResult<TOutput>;
    }
    if (request.name.startsWith("implement-")) {
      await writeFile(join(request.cwd, "a.txt"), "a\n");
      const hook = join(request.cwd, ".git", "hooks", "pre-commit");
      await writeFile(hook, "#!/bin/sh\nexit 1\n");
      await chmod(hook, 0o755);
      return { ...base, logReference: transcriptFor(request), handoff: { message: "feat(a): implement a" } } as unknown as AgentRunResult<TOutput>;
    }
    throw new Error(`unexpected agent ${request.name}`);
  };
  const provider: GitProvider = {
    name: "github",
    credential: "secret",
    mergeStrategySupport: "unsupported",
    validateRepository: () => undefined,
    createDraftPullRequest: async () => ({ number: 1, url: "https://example.test/pr/1", squashPreference: "unsupported" }),
    secrets: () => ["secret"],
  };
  const logger = await InvocationLogger.create(factoryRoot, provider.credential);
  const config: ProcessConfig = {
    ticketsDir,
    factoryRoot,
    harness: "pi",
    logger,
    gitProvider: provider,
    runAgent,
    maxParallel: 1,
    ticketAttemptsPerCycle: 1,
  };
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.map(String).join(" ")); });

  const state = createDependencyWorkflowState();
  await processDependencyCycle(config, state);

  assert.match(state.blocked.get("a")!, /implementation commit failed after a durable boundary/);
  assert.match(await readFile(join(logger.runDir, "main.log"), "utf8"), /ticket=a .*stage=implementation commit .*status=failed/);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Ticket a attempt .* failed at implementation commit/);
});

test("startup reconciliation blocks are written to main.log and surfaced on stderr", async (t) => {
  const { remote, factoryRoot, ticketsDir } = await fixture();
  await writeFile(
    join(ticketsDir, "a.md"),
    `${markdown("a", remote, [])}\n## Attempt abc123 (2026-10-11T00:00:00.000Z)\n\n- Workspace: \`/retained/a-abc123\`\n`,
  );
  const provider: GitProvider = {
    name: "github",
    credential: "secret",
    mergeStrategySupport: "unsupported",
    validateRepository: () => undefined,
    createDraftPullRequest: async () => ({ number: 1, url: "https://example.test/pr/1", squashPreference: "unsupported" }),
    secrets: () => ["secret"],
  };
  const logger = await InvocationLogger.create(factoryRoot, provider.credential);
  const config: ProcessConfig = {
    ticketsDir,
    factoryRoot,
    harness: "pi",
    logger,
    gitProvider: provider,
    runAgent: async () => { throw new Error("planner must not run for a blocked ticket"); },
    maxParallel: 1,
    ticketAttemptsPerCycle: 1,
  };
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args.map(String).join(" ")); });

  const state = createDependencyWorkflowState();
  const outcome = await processDependencyCycle(config, state);

  assert.equal(outcome, "no-runnable");
  assert.match(state.blocked.get("a")!, /prior factory evidence requires operator reconciliation/);
  assert.match(await readFile(join(logger.runDir, "main.log"), "utf8"), /ticket=a .*stage=scheduling .*status=blocked/);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Ticket a is blocked: prior factory evidence requires operator reconciliation/);
});

test("checkpoint commit, ticket annotation, and main.log all carry the runtime's invocation-relative transcript", async () => {
  const { remote, factoryRoot, ticketsDir } = await fixture();
  await writeFile(join(ticketsDir, "a.md"), markdown("a", remote, []));
  const provider: GitProvider = {
    name: "github",
    credential: "secret",
    mergeStrategySupport: "unsupported",
    validateRepository: () => undefined,
    createDraftPullRequest: async () => ({ number: 1, url: "https://example.test/pr/1", squashPreference: "unsupported" }),
    secrets: () => ["secret"],
  };
  const logger = await InvocationLogger.create(factoryRoot, provider.credential);
  const references: string[] = [];
  const runAgent: AgentRunner = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    const base = { iterations: [], commits: [], stdout: "", branch: "" };
    const transcript = await logger.allocate(request.logTarget);
    await writeFile(transcript.path, `${request.name} transcript\n`);
    const logReference = transcript.reference;
    references.push(logReference);
    if (request.name.startsWith("plan-groups-")) {
      const groupId = /<group id="([^"]+)">/.exec(request.promptArgs.GROUPS!)![1]!;
      return { ...base, logReference, handoff: { groups: [{ groupId, tickets: [{ id: "a", title: "a" }] }] } } as unknown as AgentRunResult<TOutput>;
    }
    if (request.name.startsWith("implement-")) {
      if (logReference.endsWith("implement-1.log")) {
        throw new MissingAgentHandoffError();
      }
      await writeFile(join(request.cwd, "a.txt"), "a\n");
      return { ...base, logReference, handoff: { message: "feat(a): implement a" } } as unknown as AgentRunResult<TOutput>;
    }
    if (request.name.startsWith("review-")) {
      await writeFile(join(request.cwd, "reviewed.txt"), "reviewed\n");
      return { ...base, logReference, handoff: { message: "chore(review): approved a" } } as unknown as AgentRunResult<TOutput>;
    }
    return { ...base, logReference, handoff: { title: "Deliver a", body: "Reviewed a." } } as unknown as AgentRunResult<TOutput>;
  };
  const config: ProcessConfig = { ticketsDir, factoryRoot, harness: "pi", logger, gitProvider: provider, runAgent, maxParallel: 1, ticketAttemptsPerCycle: 1 };

  await processDependencyCycle(config, createDependencyWorkflowState());

  const main = await readFile(join(logger.runDir, "main.log"), "utf8");
  const record = /stage=implementation commit .*?checkpoint=(\w{40}) .*agent-log=(\S+)/.exec(main)!;
  const checkpointSha = record[1]!;
  const recordedReference = record[2]!;
  const ticket = await readFile(join(ticketsDir, "done", "a.md"), "utf8");
  const workspacePath = /- Workspace: `([^`]+)`/.exec(ticket)![1]!;
  const trailer = (await runGit(workspacePath, ["show", "-s", "--format=%B", checkpointSha], "reading the checkpoint message")).trim();

  const attempt = recordedReference.split("/")[0]!;
  const attemptId = /- Attempt ID: `([^`]+)`/.exec(ticket)![1]!;
  assert.equal(references[0], "planner/001.log", "planner cycle 1 writes planner/001.log");
  assert.deepEqual(references.slice(1, 4), [`${attempt}/implement-1.log`, `${attempt}/implement-2.log`, `${attempt}/review-1.log`], "the failed run consumed implement-1 and the retry got implement-2 in the same attempt directory");
  assert.match(references[4]!, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-group-[^/]+\/pull-request-1\.log$/, "publication runs in its own timestamped attempt directory");
  assert.equal(recordedReference, references[2], "main.log records the reference the runtime handed the successful retry");
  assert.match(recordedReference, /^[^/]+\/implement-2\.log$/, "the reference is invocation-relative, not a basename");
  assert.equal(attempt.slice(attempt.lastIndexOf("-") + 1), attemptId, "the attempt directory is named for its attempt ID inside the instance directory");
  const entries = await readdir(logger.runDir);
  assert.ok(entries.includes("main.log") && entries.includes(attempt) && entries.includes("planner"), `instance directory holds main.log, planner/, and the attempt directory, got ${entries.join(", ")}`);
  for (const reference of references) {
    await access(join(logger.runDir, reference));
  }
  assert.ok(trailer.includes(`Factory-Agent-Log: ${recordedReference}`), "the checkpoint trailer carries the reference the runtime handed the stage");
  assert.ok(ticket.includes(`- Agent log: \`${recordedReference}\``), "the ticket annotation carries the same reference");
  assert.ok(ticket.includes(`- Agent log: \`${attempt}/review-1.log\``), "the review checkpoint annotates its own transcript");
});
