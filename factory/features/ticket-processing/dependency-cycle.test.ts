import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRequest, AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { MissingAgentHandoffError } from "../../infrastructure/agent-runtime/handoff.js";
import { runCommand, runGit } from "../../infrastructure/git-provider/git.js";
import { createGitProviderRegistry } from "../../infrastructure/git-provider/create-git-provider.js";
import type { DraftPullRequestRequest, Fetch } from "../../infrastructure/git-provider/git-provider.js";
import { InvocationLogger } from "../../infrastructure/logging/invocation-log.js";
import { redactSecrets } from "../../shared/redact-secret.js";
import { BacklogWorkflow } from "./backlog-workflow.js";
import { createIssueAuthorizationReader } from "./authorization-guard.js";
import { PublicationLedger } from "./publication-ledger.js";
import { createDependencyWorkflowState, processDependencyCycle } from "./dependency-cycle.js";
import { JobLimiter } from "./job-limiter.js";
import type { ProcessConfig } from "./process-config.js";
import {
  TEST_ADO_REPOSITORY as ADO_REPOSITORY,
  TEST_AZURE_DEVOPS_PAT as AZURE_DEVOPS_PAT,
  TEST_GITHUB_TOKEN as GITHUB_TOKEN,
  TEST_REPOSITORY as TARGET_REPOSITORY,
  TestBacklog,
  type TestSeed as Seed,
} from "./test-backlog.js";

// The backlog is the only ticket source, so every fixture seeds authored issues plus their Project
// board entries, and the coordinator settles its findings back onto those issues. Credentials are
// fixtures; the target repository is a canonical GitHub SSH URL that a fixture `ssh` serves from a
// real local bare repository, so clone, merge, and push stay real Git operations.

process.env.GIT_AUTHOR_NAME = "Dependency Test";
process.env.GIT_AUTHOR_EMAIL = "dependency@test.example";
process.env.GIT_COMMITTER_NAME = "Dependency Test";
process.env.GIT_COMMITTER_EMAIL = "dependency@test.example";

/** One pull request as the fake provider stores it; its head SHA is always read from the real remote. */
type FakePull = Readonly<{ number: number; url: string; head: string; base: string; title: string; body: string; draft: boolean; state: "open" | "closed"; created: string; mergedAt: string | null; mergeCommitSha: string | null }>;

/** The GitHub REST pulls endpoints, served from an in-memory pull list over the real local remote. */
function fakeGitHub(remote: string, pulls: FakePull[]) {
  const creates: DraftPullRequestRequest[] = [];
  const patches: Readonly<{ number: number; title: string; body: string }>[] = [];
  let nextCreateFailure = false;
  /** An operator merges the draft: the fake reports the merge-result commit the test pushed to `main`. */
  const merge = (number: number, mergeCommitSha: string) => {
    const index = pulls.findIndex((pull) => pull.number === number);
    pulls[index] = { ...pulls[index]!, state: "closed", mergedAt: "2026-10-16T08:00:00.000Z", mergeCommitSha };
  };
  const record = (pull: FakePull) => ({
    number: pull.number,
    html_url: pull.url,
    state: pull.state,
    draft: pull.draft,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    title: pull.title,
    body: pull.body,
  });
  const sourceSha = async (branch: string) => {
    try {
      return (await runCommand("git", ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`], "reading published branch")).trim();
    } catch {
      return "0".repeat(40);
    }
  };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, statusText: status === 200 ? "OK" : "Not Found" });

  const fetchImpl: Fetch = async (url, init) => {
    const target = new URL(url);
    const payload = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const text = (key: string) => String(payload[key] ?? "");
    if (target.pathname === "/repos/acme/app/pulls" && init.method === "POST") {
      if (nextCreateFailure) {
        nextCreateFailure = false;
        return json({ message: "temporary provider failure" }, 503);
      }
      creates.push({ repositoryUrl: TARGET_REPOSITORY, head: text("head"), base: text("base"), title: text("title"), body: text("body"), mergeStrategy: "squash" });
      const number = 100 + pulls.length;
      const pull: FakePull = { number, url: `https://github.com/acme/app/pull/${number}`, head: text("head"), base: text("base"), title: text("title"), body: text("body"), draft: payload.draft === true, state: "open", created: `2026-10-16T07:00:0${pulls.length}.000Z`, mergedAt: null, mergeCommitSha: null };
      pulls.push(pull);
      return json({ number, html_url: pull.url });
    }
    const single = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(target.pathname);
    if (single !== null) {
      const pull = pulls.find((candidate) => candidate.number === Number(single[1]));
      if (pull === undefined) return json({ message: "Not Found" }, 404);
      if (init.method === "PATCH") {
        patches.push({ number: pull.number, title: text("title"), body: text("body") });
        pulls[pulls.indexOf(pull)] = { ...pull, title: text("title"), body: text("body") };
        return json({ number: pull.number, html_url: pull.url });
      }
      return json({
        ...record(pull),
        head: { ref: pull.head, sha: await sourceSha(pull.head) },
        base: { ref: pull.base },
      });
    }
    assert.equal(target.pathname, "/repos/acme/app/pulls", `unexpected provider request ${init.method} ${url}`);
    const head = target.searchParams.get("head")!.split(":")[1]!;
    const base = target.searchParams.get("base")!;
    const items = await Promise.all(
      pulls
        .filter((pull) => pull.head === head && pull.base === base)
        .map(async (pull) => ({
          ...record(pull),
          created_at: pull.created,
          head: { ref: pull.head, sha: await sourceSha(pull.head) },
          base: { ref: pull.base },
        })),
    );
    return json(items);
  };

  return { fetchImpl, creates, patches, merge, failNextCreate: () => { nextCreateFailure = true; } };
}

/** One fixture: a real target bare repository, a real factory checkout with no `tickets/`, and the backlog issues. */
async function fixture(seeds: readonly Seed[]) {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-backlog-"));
  const remote = join(root, "remote.git");
  const seedDirectory = join(root, "seed");
  const factoryRoot = join(root, "factory");
  await runCommand("git", ["init", "--bare", remote], "creating remote");
  await runCommand("git", ["clone", remote, seedDirectory], "cloning seed");
  await runGit(seedDirectory, ["checkout", "-B", "main"], "creating main");
  await writeFile(join(seedDirectory, "README.md"), "# app\n");
  await runGit(seedDirectory, ["add", "README.md"], "staging seed");
  await runGit(seedDirectory, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], "committing seed");
  await runGit(seedDirectory, ["push", "origin", "main"], "pushing seed");
  await runCommand("git", ["init", "-b", "main", factoryRoot], "creating factory");
  await writeFile(join(factoryRoot, "README.md"), "factory\n");
  await writeFile(join(factoryRoot, ".gitignore"), ".logs/\n.workspaces/\n");
  await runGit(factoryRoot, ["add", "README.md", ".gitignore"], "staging factory");
  await runGit(factoryRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "factory"], "committing factory");

  // The runner names the canonical GitHub SSH URL, so a fixture `ssh` serves exactly that
  // repository from the local bare remote over the real Git transport; clone, merge, and push stay real.
  const ssh = join(root, "fake-ssh.sh");
  await writeFile(ssh, [
    "#!/bin/sh",
    `REPO='${remote}'`,
    'for argument in "$@"; do command="$argument"; done',
    'case "$command" in',
    '  git-upload-pack*) exec git-upload-pack "$REPO" ;;',
    '  git-receive-pack*) exec git-receive-pack "$REPO" ;;',
    '  *) echo "fixture ssh received an unexpected command: $command" >&2; exit 128 ;;',
    'esac',
    "",
  ].join("\n"));
  await chmod(ssh, 0o755);
  process.env.GIT_SSH_COMMAND = ssh;

  const pulls: FakePull[] = [];
  const { fetchImpl, creates, patches, merge, failNextCreate } = fakeGitHub(remote, pulls);
  const providers = createGitProviderRegistry({ GITHUB_TOKEN, AZURE_DEVOPS_PAT, GITHUB_REPOSITORY: "acme/tickets" }, fetchImpl);
  const backlog = new TestBacklog();
  for (const entry of seeds) backlog.seed(entry);
  const secrets = [...providers.secrets, ...backlog.secrets];
  const ledger = PublicationLedger.open(factoryRoot);
  const workflow = new BacklogWorkflow(backlog, ledger, (text) => redactSecrets(secrets, text), undefined, createIssueAuthorizationReader({ backlog, providers }));
  await workflow.validate();
  const logger = await InvocationLogger.create(factoryRoot, secrets);
  return { root, remote, factoryRoot, backlog, ledger, workflow, logger, providers, pulls, creates, patches, merge, failNextCreate };
}

/** The coordinator's own checkout carries no ticket files: the backlog is the ticket source. */
async function assertNoTicketCheckout(factoryRoot: string): Promise<void> {
  assert.equal((await readdir(factoryRoot)).includes("tickets"), false);
  await assert.rejects(readFile(join(factoryRoot, "tickets", "a.md"), "utf8"), { code: "ENOENT" });
}

/** Every fake agent run writes a real transcript and returns the handoff `run` produces for it. */
function transcriptRunner(logger: InvocationLogger, run: (request: AgentRunRequest<unknown>) => Promise<Record<string, unknown>>): AgentRunner {
  return async <TOutput>(request: AgentRunRequest<TOutput>) => {
    const transcript = await logger.allocate(request.logTarget);
    await writeFile(transcript.path, `${request.name} transcript\n`);
    const handoff = await run(request as unknown as AgentRunRequest<unknown>);
    return { iterations: [], commits: [], stdout: "", branch: "", logReference: transcript.reference, handoff } as unknown as AgentRunResult<TOutput>;
  };
}

/** The planner answers with every supplied group and its full membership. */
async function planAll(request: AgentRunRequest<unknown>): Promise<Record<string, unknown>> {
  const groups = request.promptArgs.GROUPS!;
  const groupId = /<group id="([^"]+)">/.exec(groups)![1]!;
  return { groups: [{ groupId, tickets: [...groups.matchAll(/- ([^:]+): (.+)/g)].map((match) => ({ id: match[1]!, title: match[2]! })) }] };
}

function successfulRunner(logger: InvocationLogger, implement?: (request: AgentRunRequest<unknown>) => Promise<void>): AgentRunner {
  return transcriptRunner(logger, async (request) => {
    if (request.name.startsWith("plan-groups-")) return planAll(request);
    if (request.name.startsWith("implement-")) {
      await implement?.(request);
      const id = request.promptArgs.TICKET_ID!;
      await writeFile(join(request.cwd, `${id}.txt`), `${id}\n`);
      return { message: `feat(${id}): implement ${id}` };
    }
    if (request.name.startsWith("review-")) return { message: "chore(review): verify behavior" };
    if (request.name.startsWith("integrate-")) return { message: "chore(integration): verify group", conflicts: [] };
    return { title: "Deliver reviewed work", body: "Reviewed dependency group." };
  });
}

test("diamond dependencies use isolated sibling baselines, bounded overlap, reviewed integration, and one group publication settled on every issue", async () => {
  const { factoryRoot, backlog, ledger, workflow, logger, providers, creates } = await fixture([
    { id: "a", number: 11, status: "Ready" },
    { id: "b", number: 12, status: "Ready", dependencies: ["a"] },
    { id: "c", number: 13, status: "Ready", dependencies: ["a"] },
    { id: "d", number: 14, status: "Ready", dependencies: ["b", "c"] },
    { id: "azure-only", number: 15, status: "Blocked", repository: ADO_REPOSITORY },
  ]);
  await assertNoTicketCheckout(factoryRoot);
  assert.equal(providers.resolve(ADO_REPOSITORY).name, "azure-devops", "the Azure DevOps ticket routes to its own adapter");

  let activeImplementations = 0;
  let maxActiveImplementations = 0;
  const siblingBarrier = Promise.withResolvers<void>();
  const baselines = new Map<string, string[]>();
  const runAgent = transcriptRunner(logger, async (request) => {
    if (request.name.startsWith("plan-groups-")) return planAll(request);
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
      return { message: `feat(${id}): implement ${id}` };
    }
    if (request.name.startsWith("review-")) return { message: "chore(review): verify combined behavior" };
    if (request.name.startsWith("integrate-")) {
      const conflicts = request.promptArgs.CONFLICT_PATHS === "none" ? [] : request.promptArgs.CONFLICT_PATHS!.split("\n");
      if (conflicts.includes("shared.txt")) {
        await writeFile(join(request.cwd, "shared.txt"), "b\nc\n");
        await runGit(request.cwd, ["add", "shared.txt"], "resolving integration fixture conflict");
      }
      return { message: "chore(integration): review combined behavior", conflicts: conflicts.map((path) => ({ path, disposition: "combined" })) };
    }
    return { title: "Deliver dependency group", body: "Reviewed as one dependency group." };
  });
  const config: ProcessConfig = {
    factoryRoot,
    harness: "pi",
    logger,
    providers,
    backlog,
    workflow,
    ledger,
    runAgent: new JobLimiter(2).wrap(runAgent),
    maxParallel: 2,
    ticketAttemptsPerCycle: 2,
  };

  const state = createDependencyWorkflowState();
  assert.equal(await processDependencyCycle(config, state), "processed");
  assert.deepEqual([...state.blocked.keys()], [], JSON.stringify([...state.retryable]));

  assert.equal(maxActiveImplementations, 2, "the cycle never ran more than its bounded overlap");
  assert.deepEqual(baselines.get("b"), ["README.md", "a.txt"]);
  assert.deepEqual(baselines.get("c"), ["README.md", "a.txt"]);
  assert.deepEqual(baselines.get("d"), ["README.md", "a.txt", "b.txt", "c.txt", "shared.txt"]);

  assert.equal(creates.length, 1, "one dependency group publishes exactly one draft pull request");
  assert.match(creates[0]!.body, /Included: a \(a\), b \(b\), c \(c\), d \(d\)/);
  assert.match(creates[0]!.body, /shared\.txt: combined/);

  const pullRequestUrl = "https://github.com/acme/app/pull/100";
  for (const [id, number] of [["a", 11], ["b", 12], ["c", 13], ["d", 14]] as const) {
    assert.equal(backlog.statusOf(id), "In review", `${id} never reached the review column`);
    assert.deepEqual(backlog.transitions.filter((entry) => entry.startsWith(`${id}=`)), [`${id}=In progress`, `${id}=In review`]);
    assert.equal(backlog.bodies(id).filter((body) => body.includes("## Factory attempt started")).length, 1);
    const published = backlog.bodiesWith(id, `factory:publication:issue-${number}:https-github.com-acme-app-pull-100`);
    assert.equal(published.length, 1, `${id} has no publication comment: ${JSON.stringify(backlog.bodies(id))}`);
    assert.match(published[0]!, new RegExp(`- Pull request: #100 ${pullRequestUrl}`));
    assert.match(published[0]!, new RegExp(`- Ticket: \\\`${id}\\\``));
    assert.match(published[0]!, /Requested merge method: squash \(unsupported\)/);
    for (const body of backlog.bodies(id)) assert.ok(!body.includes(GITHUB_TOKEN), "a fixture credential reached an issue comment");
  }

  const snapshot = await ledger.load();
  assert.deepEqual(snapshot.corrupt, []);
  assert.deepEqual(snapshot.settlements, [], "every settled effect completed, so nothing awaits replay");
  assert.equal(snapshot.intents.length, 1);
  assert.equal(snapshot.results.length, 1);
  const result = snapshot.results[0]!;
  assert.equal(result.operationKey, snapshot.intents[0]!.operationKey);
  assert.equal(result.pullRequestUrl, pullRequestUrl);
  assert.equal(result.provider, "github");
  assert.equal(result.repository, TARGET_REPOSITORY);
  assert.equal(result.mergeStrategy, "squash");
  assert.deepEqual(result.included.map((entry) => [entry.ticketId, entry.issueNumber, entry.issueNodeId]), [
    ["a", 11, "I_NODE_a"], ["b", 12, "I_NODE_b"], ["c", 13, "I_NODE_c"], ["d", 14, "I_NODE_d"],
  ]);

  assert.equal(backlog.statusOf("azure-only"), "Blocked", "a parked Azure DevOps issue is never scheduled");
  assert.deepEqual(backlog.bodies("azure-only"), []);
});

test("an exhausted issue publishes its reviewed ancestor, parks its descendants on the board, then retries fresh and extends the same draft", async () => {
  const { remote, factoryRoot, backlog, ledger, workflow, logger, providers, creates, patches } = await fixture([
    { id: "a", number: 21, status: "Ready" },
    { id: "b", number: 22, status: "Ready", dependencies: ["a"] },
    { id: "c", number: 23, status: "Ready", dependencies: ["b"] },
  ]);
  let cycle = 1;
  let bImplementRuns = 0;
  let cImplementRuns = 0;
  const bWorkspaces = new Set<string>();
  let freshRetryWasClean = false;
  const runAgent = transcriptRunner(logger, async (request) => {
    if (request.name.startsWith("plan-groups-")) return planAll(request);
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
      return { message: `feat(${id}): implement ${id}` };
    }
    if (request.name.startsWith("review-")) return { message: "chore(review): verify behavior" };
    if (request.name.startsWith("integrate-")) return { message: "chore(integration): verify group", conflicts: [] };
    return { title: `Cycle ${cycle}`, body: `Cycle ${cycle} delivery.` };
  });
  const config: ProcessConfig = { factoryRoot, harness: "pi", logger, providers, backlog, workflow, ledger, runAgent, maxParallel: 1, ticketAttemptsPerCycle: 1 };
  const state = createDependencyWorkflowState();

  await processDependencyCycle(config, state);

  assert.deepEqual([...state.reviewed.keys()], ["a"]);
  assert.equal(cImplementRuns, 0, "a descendant of an exhausted issue is never implemented");
  assert.equal(creates.length, 1);
  assert.match(creates[0]!.body, /Retryable: b/);
  assert.match(creates[0]!.body, /Blocked: c/);
  assert.equal(backlog.statusOf("a"), "In review");
  assert.equal(backlog.statusOf("b"), "Blocked");
  assert.match(state.blocked.get("c")!, /waiting for dependencies: b/);
  const exhausted = backlog.bodiesWith("b", "factory:failure:issue-22:attempts-1");
  assert.equal(exhausted.length, 1, JSON.stringify(backlog.bodies("b")));
  assert.match(exhausted[0]!, /The attempt's workspace is retained/);

  // The runner parked the exhausted issue on the board, so only an operator re-queue resumes it.
  backlog.moveTo("b", "Ready");
  cycle = 2;
  await processDependencyCycle(config, state);

  assert.equal(bImplementRuns, 4, "three failed iterations in the retained workspace, then one fresh run");
  assert.equal(bWorkspaces.size, 2, "the retry runs in a second workspace, not the retained one");
  assert.equal(freshRetryWasClean, true, "the fresh workspace carries nothing from the failed attempt");
  assert.equal(cImplementRuns, 1, "the descendant resumes once its dependency is reviewed again");
  assert.deepEqual([...state.reviewed.keys()], ["a", "b", "c"]);
  assert.equal(creates.length, 1, "the resumed work extends the tracked draft instead of opening a second one");
  assert.equal(patches.length, 1);
  assert.match(patches[0]!.body, /Included: a \(a\), b \(b\), c \(c\)/);
  assert.equal(backlog.statusOf("b"), "In review");
  assert.equal(backlog.statusOf("c"), "In review");
  assert.deepEqual(backlog.transitions.filter((entry) => entry.startsWith("b=")), ["b=In progress", "b=Blocked", "b=In progress", "b=In review"]);

  assert.equal(backlog.bodiesWith("b", "factory:failure:issue-22:attempts-1").length, 1, "one exhausted-attempt report is never repeated");
  assert.equal(backlog.bodies("a").filter((body) => body.includes("## Factory pull request")).length, 1, "an already published issue is commented on once");
  for (const id of ["b", "c"] as const) {
    assert.equal(backlog.bodiesWith(id, `factory:publication:issue-${backlog.issueNumber(id)}:https-github.com-acme-app-pull-100`).length, 1);
  }

  const snapshot = await ledger.load();
  assert.equal(snapshot.intents.length, 2, "each publication is durable before its push");
  assert.equal(snapshot.results.length, 2);
  assert.deepEqual(snapshot.settlements, []);
  // Ledger files are keyed by operation, so the extension is found by the work it carries.
  const extended = snapshot.results.find((result) => result.included.length === 3)!;
  assert.deepEqual(extended.included.map((entry) => entry.ticketId), ["a", "b", "c"]);
  assert.equal(extended.pullRequestNumber, 100, "the extension updated the tracked draft");
  const actualHead = (await runCommand("git", ["--git-dir", remote, "rev-parse", `refs/heads/${extended.head}`], "reading extended draft head")).trim();
  assert.equal(extended.sourceSha, actualHead, "the ledger records the actual tracked draft head, not an intermediate candidate");
  assert.equal(await processDependencyCycle(config, state), "no-runnable", "the third cycle accepts the extended publication");
  const restarted = createDependencyWorkflowState();
  assert.equal(await processDependencyCycle(config, restarted), "no-runnable", "restart reconciles only the latest revision of the draft");
  assert.deepEqual([...restarted.blocked], []);
  assert.deepEqual([...restarted.published].sort(), ["a", "b", "c"]);
  assert.equal([...restarted.publications.values()][0]!.sourceSha, actualHead);
  assert.equal(creates.length, 1);
  assert.equal(patches.length, 1, "reconciliation never rewrites an unchanged draft");
});

test("an unresolvable integration conflict publishes each reviewed leaf on its own subset draft, settled once per issue", async () => {
  const { factoryRoot, backlog, ledger, workflow, logger, providers, creates } = await fixture([
    { id: "a", number: 31, status: "Ready" },
    { id: "b", number: 32, status: "Ready", dependencies: ["a"] },
    { id: "c", number: 33, status: "Ready", dependencies: ["a"] },
  ]);
  const conflictPaths: string[] = [];
  const runAgent = transcriptRunner(logger, async (request) => {
    if (request.name.startsWith("plan-groups-")) return planAll(request);
    if (request.name.startsWith("implement-")) {
      const id = request.promptArgs.TICKET_ID!;
      await writeFile(join(request.cwd, "shared.txt"), id === "a" ? "base\n" : `from ${id}\n`);
      return { message: `feat(${id}): implement ${id}` };
    }
    if (request.name.startsWith("review-")) return { message: "chore(review): verify combined behavior" };
    if (request.name.startsWith("integrate-")) {
      conflictPaths.push(request.promptArgs.CONFLICT_PATHS!);
      return { message: "chore(integration): leave the conflict for an author", conflicts: [] };
    }
    return { title: "Deliver one reviewed leaf", body: "Reviewed leaf subset." };
  });
  const config: ProcessConfig = { factoryRoot, harness: "pi", logger, providers, backlog, workflow, ledger, runAgent: new JobLimiter(1).wrap(runAgent), maxParallel: 1, ticketAttemptsPerCycle: 1 };
  const state = createDependencyWorkflowState();
  assert.equal(await processDependencyCycle(config, state), "processed");

  assert.deepEqual(conflictPaths, ["shared.txt"], "the real Git conflict is handed to the integration review");
  assert.equal(creates.length, 2, "each reviewed leaf publishes its own dependency-closed subset");
  const published = [...creates].sort((left, right) => left.head.localeCompare(right.head));
  assert.match(published[0]!.head, /^agent-tickets\/b-/);
  assert.match(published[1]!.head, /^agent-tickets\/c-/);
  assert.match(published[0]!.body, /Included: a \(a\), b \(b\)/);
  assert.ok(!published[0]!.body.includes("c (c)"), "the b subset carries nothing from the conflicting sibling");
  assert.match(published[1]!.body, /Included: a \(a\), c \(c\)/);
  assert.ok(!published[1]!.body.includes("b (b)"), "the c subset carries nothing from the conflicting sibling");

  // Each subset settles only the issues it newly carries, so the shared ancestor is commented on once.
  for (const id of ["a", "b", "c"] as const) {
    assert.equal(backlog.statusOf(id), "In review");
    assert.deepEqual(backlog.transitions.filter((entry) => entry.startsWith(`${id}=`)), [`${id}=In progress`, `${id}=In review`]);
  }
  assert.equal(backlog.bodies("a").filter((body) => body.includes("## Factory pull request")).length, 1);
  assert.equal(backlog.bodiesWith("a", "factory:publication:issue-31:https-github.com-acme-app-pull-100").length, 1);
  assert.equal(backlog.bodiesWith("b", "factory:publication:issue-32:https-github.com-acme-app-pull-100").length, 1, JSON.stringify(backlog.bodies("b")));
  assert.equal(backlog.bodiesWith("c", "factory:publication:issue-33:https-github.com-acme-app-pull-101").length, 1, JSON.stringify(backlog.bodies("c")));

  const snapshot = await ledger.load();
  assert.deepEqual(snapshot.settlements, []);
  assert.deepEqual(snapshot.corrupt, []);
  assert.equal(snapshot.intents.length, 2);
  assert.equal(snapshot.results.length, 2);
  assert.deepEqual(
    snapshot.results
      .map((result) => [result.groupId.slice(result.groupId.lastIndexOf("-") + 1), result.included.map((entry) => entry.ticketId).join(",")])
      .sort(),
    [["b", "a,b"], ["c", "a,c"]],
    "each leaf recorded its own dependency-closed subset",
  );

  assert.equal(await processDependencyCycle(config, state), "no-runnable");
  assert.equal(creates.length, 2, "published subsets are never published again");
  assert.equal(backlog.markerBodies("a").length, 2, "the ancestor keeps exactly one start comment and one publication comment");
});

test("a merged draft is verified from its real merge-result commit and settles its issues as Done and closed", async () => {
  const { root, remote, factoryRoot, backlog, ledger, workflow, logger, providers, creates, merge } = await fixture([
    { id: "a", number: 41, status: "Ready" },
    { id: "b", number: 42, status: "Ready", dependencies: ["a"] },
  ]);
  const runAgent = transcriptRunner(logger, async (request) => {
    if (request.name.startsWith("plan-groups-")) return planAll(request);
    if (request.name.startsWith("implement-")) {
      const id = request.promptArgs.TICKET_ID!;
      if (id === "c") assert.equal(await readFile(join(request.cwd, "b.txt"), "utf8"), "b\n", "the new child starts from its parent's verified merge result");
      await writeFile(join(request.cwd, `${id}.txt`), `${id}\n`);
      return { message: `feat(${id}): implement ${id}` };
    }
    if (request.name.startsWith("review-")) return { message: "chore(review): verify combined behavior" };
    if (request.name.startsWith("integrate-")) return { message: "chore(integration): review combined behavior", conflicts: [] };
    return { title: "Deliver the reviewed group", body: "Reviewed as one dependency group." };
  });
  const config: ProcessConfig = { factoryRoot, harness: "pi", logger, providers, backlog, workflow, ledger, runAgent, maxParallel: 1, ticketAttemptsPerCycle: 1 };
  const state = createDependencyWorkflowState();
  assert.equal(await processDependencyCycle(config, state), "processed");
  assert.equal(creates.length, 1);
  assert.equal(backlog.statusOf("b"), "In review");
  const published = (await ledger.load()).results[0]!;

  // An operator merges the draft: the published tree lands on `main` as a real merge-result commit.
  const mergeClone = join(root, "merge");
  await runCommand("git", ["clone", remote, mergeClone], "cloning for the merge");
  const mergeSha = (await runGit(mergeClone, ["commit-tree", `${published.sourceSha}^{tree}`, "-p", published.baseSha, "-m", "Merge pull request #100"], "creating the merge result")).trim();
  await runGit(mergeClone, ["update-ref", "refs/heads/main", mergeSha], "moving main to the merge result");
  await runGit(mergeClone, ["push", "origin", "main"], "pushing the merge result");
  merge(100, mergeSha);

  assert.equal(await processDependencyCycle(config, state), "no-runnable", "settled issues leave the work graph");
  for (const [id, number] of [["a", 41], ["b", 42]] as const) {
    assert.equal(backlog.statusOf(id), "Done");
    const settled = backlog.bodiesWith(id, `factory:settlement:issue-${number}:https-github.com-acme-app-pull-100`);
    assert.equal(settled.length, 1, `${id} has no merge settlement: ${JSON.stringify(backlog.bodies(id))}`);
    assert.match(settled[0]!, /## Factory merged/);
    assert.ok(settled[0]!.includes(`- Merge commit: \`${mergeSha}\``), settled[0]!);
  }
  assert.deepEqual(backlog.closed, [41, 42]);
  assert.deepEqual([...state.settled].sort(), ["a", "b"]);
  assert.equal(creates.length, 1, "a merged publication is never published again");

  const snapshot = await ledger.load();
  assert.deepEqual(snapshot.settlements, [], "every settlement completed, so nothing awaits replay");
  assert.equal(snapshot.results.length, 1, "a settled publication stays recorded");

  backlog.seed({ id: "c", number: 43, status: "Ready", dependencies: ["b"] });
  assert.equal(await processDependencyCycle(config, state), "processed", "a closed merged parent satisfies a newly authored child");
  assert.equal(backlog.statusOf("c"), "In review");
  assert.equal(backlog.statusOf("b"), "Done");
  assert.equal(creates.length, 2, "the child publishes new work without republishing the merged draft");
  assert.match(creates[1]!.body, /Included: c \(c\)/);
  assert.ok(!creates[1]!.body.includes("b (b)"), "the merged dependency is not included in the new publication");
  assert.equal(state.blocked.has("c"), false);
});

test("startup reconciliation retires a vanished draft, replays unfinished settlements, and blocks an issue In review with no record", async () => {
  const { factoryRoot, backlog, ledger, workflow, logger, providers, creates } = await fixture([
    { id: "lost", number: 51, status: "In review" },
    { id: "orphan", number: 52, status: "In review" },
    { id: "parked", number: 53, status: "Blocked" },
  ]);
  await ledger.writeResult({
    version: 1,
    operationKey: "factory:publication:group-g1:vanished",
    groupId: "g1",
    provider: "github",
    repository: TARGET_REPOSITORY,
    baseBranch: "main",
    baseSha: "1".repeat(40),
    head: "agent-tickets/lost-deadbeef",
    sourceSha: "2".repeat(40),
    title: "Lost draft",
    body: "Its pull request no longer exists.",
    mergeStrategy: "squash",
    included: [{ ticketId: "lost", issueNumber: 51, issueNodeId: "I_NODE_lost", requirementsHash: "3".repeat(64) }],
    recordedAt: "2026-10-15T07:00:00.000Z",
    pullRequestNumber: 100,
    pullRequestUrl: "https://github.com/acme/app/pull/100",
    squashPreference: "unsupported",
    publishedAt: "2026-10-15T07:00:01.000Z",
  });
  await ledger.recordSettlement({
    version: 1,
    operationKey: "factory:settlement:issue-53:status-blocked",
    kind: "status",
    subject: "issue-53",
    status: "Blocked",
    ticketId: "parked",
    issueNumber: 53,
    issueNodeId: "I_NODE_parked",
    detail: "status-blocked",
    recordedAt: "2026-10-15T07:00:00.000Z",
  });
  await writeFile(join(factoryRoot, ".factory-state", "publication-result-corrupt-example.json"), "{ not json\n");

  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  let outcome = "";
  const state = createDependencyWorkflowState();
  let config: ProcessConfig;
  try {
    const runAgent = transcriptRunner(logger, async (request) => {
      if (request.name.startsWith("plan-groups-")) return planAll(request);
      if (request.name.startsWith("implement-")) {
        await writeFile(join(request.cwd, "lost.txt"), "lost\n");
        return { message: "feat(lost): implement lost" };
      }
      if (request.name.startsWith("review-")) return { message: "chore(review): verify combined behavior" };
      if (request.name.startsWith("integrate-")) return { message: "chore(integration): review combined behavior", conflicts: [] };
      return { title: "Recover the lost draft", body: "Published again after its pull request vanished." };
    });
    config = { factoryRoot, harness: "pi", logger, providers, backlog, workflow, ledger, runAgent, maxParallel: 1, ticketAttemptsPerCycle: 1 };
    outcome = await processDependencyCycle(config, state);

    assert.match(state.blocked.get("lost")!, /pull request 100 for lost is no longer an open draft/);
    assert.match(state.blocked.get("orphan")!, /In review with no recorded pull request/);
    assert.deepEqual(backlog.transitions, ["lost=Ready", "orphan=Blocked"], "the retired publication restores development eligibility without overwriting it as Blocked");
    assert.equal(backlog.statusOf("lost"), "Ready");
    const resumed = backlog.bodiesWith("lost", "factory:comment:issue-51:pull-request-100");
    assert.equal(resumed.length, 1, JSON.stringify(backlog.bodies("lost")));
    assert.match(resumed[0]!, /## Factory resumed/);
    assert.equal(backlog.bodies("orphan").length, 1, JSON.stringify(backlog.bodies("orphan")));
    const corrupt = errors.filter((line) => line.includes("publication-result-corrupt-example.json"));
    assert.equal(corrupt.length, 1, JSON.stringify(errors));
    assert.match(corrupt[0]!, /requires operator reconciliation/);
    assert.equal(logs.filter((line) => line.includes("Replayed the recorded settlement status-blocked for issue #53")).length, 1);
    assert.equal(creates.length, 0, "reconciliation publishes nothing");

    const retired = await ledger.load();
    assert.deepEqual(retired.results, [], "the vanished publication is un-recorded so its work can publish again");
    assert.deepEqual(retired.intents, []);
    // A settlement whose effect the board already shows is completed by the replay, so it never replays again.
    assert.deepEqual(retired.settlements, [], "the replayed settlement record is consumed once its effect is confirmed");
    assert.equal(retired.corrupt.length, 1);

    // Retirement restores Ready, but this process defers it until restart.
    outcome = await processDependencyCycle(config, state);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(outcome, "no-runnable");
  assert.equal(creates.length, 0, "a retired publication waits for operator reconciliation, it is never republished silently");
  assert.equal(backlog.bodiesWith("lost", "factory:comment:issue-51:pull-request-100").length, 1, "the resume is reported exactly once");
  assert.equal(backlog.bodies("lost").filter((body) => body.includes("## Factory blocked")).length, 0, JSON.stringify(backlog.bodies("lost")));
});

test("restart restores a published parent's baseline for a new child and recovers a lost extension result without creating another draft", async () => {
  const { remote, factoryRoot, backlog, ledger, workflow, logger, providers, creates, patches } = await fixture([
    { id: "a", number: 61, status: "Ready" },
  ]);
  const implemented: string[] = [];
  const runAgent = successfulRunner(logger, async (request) => {
    const id = request.promptArgs.TICKET_ID!;
    implemented.push(id);
    if (id === "b") assert.equal(await readFile(join(request.cwd, "a.txt"), "utf8"), "a\n", "restart recovers the published parent, not main, as the child's baseline");
  });
  const config: ProcessConfig = { factoryRoot, harness: "pi", logger, providers, backlog, workflow, ledger, runAgent, maxParallel: 1, ticketAttemptsPerCycle: 1 };
  assert.equal(await processDependencyCycle(config, createDependencyWorkflowState()), "processed");
  const parent = (await ledger.load()).results[0]!;

  backlog.seed({ id: "b", number: 62, status: "Ready", dependencies: ["a"] });
  const restarted = createDependencyWorkflowState();
  assert.equal(await processDependencyCycle(config, restarted), "processed");
  assert.deepEqual(implemented, ["a", "b"], "the already published parent is not implemented again");
  assert.equal(backlog.statusOf("b"), "In review");
  assert.deepEqual([...restarted.blocked], []);
  assert.equal(creates.length, 1, "the recovered parent and new child share the original draft");
  assert.equal(patches.length, 1);
  const extended = (await ledger.load()).results.find((result) => result.included.length === 2)!;
  assert.equal(extended.pullRequestNumber, parent.pullRequestNumber);
  assert.equal(extended.head, parent.head);
  const actualHead = (await runCommand("git", ["--git-dir", remote, "rev-parse", `refs/heads/${extended.head}`], "reading recovered draft head")).trim();
  assert.equal(extended.sourceSha, actualHead);
  assert.match(patches[0]!.body, /Included: a \(a\), b \(b\)/);

  // Simulate a process losing its result write after the provider accepted the extension.
  // Keep the intent, real remote branch, pull request, and historical parent result intact.
  await rm(join(ledger.directory, `publication-result-${extended.operationKey}.json`));
  const recovering = createDependencyWorkflowState();
  assert.equal(await processDependencyCycle(config, recovering), "no-runnable");
  assert.deepEqual([...recovering.blocked], []);
  assert.deepEqual([...recovering.published].sort(), ["a", "b"]);
  assert.deepEqual(implemented, ["a", "b"]);
  assert.equal(creates.length, 1, "the unmatched intent adopts the provider write instead of creating a duplicate");
  assert.equal(patches.length, 1, "intent recovery does not rewrite the provider");
  const recovered = (await ledger.load()).results.find((result) => result.operationKey === extended.operationKey)!;
  assert.equal(recovered.pullRequestNumber, 100);
  assert.equal(recovered.sourceSha, actualHead);
  assert.deepEqual(recovered.included.map((entry) => entry.ticketId), ["a", "b"]);
});

test("fresh discovery evicts cached tickets whose authored metadata becomes invalid or duplicated", async () => {
  const { factoryRoot, backlog, ledger, workflow, logger, providers, creates } = await fixture([
    { id: "invalid", number: 71, status: "Backlog" },
    { id: "duplicate", number: 72, status: "Backlog" },
    { id: "unrelated", number: 74, status: "Backlog" },
  ]);
  const implemented: string[] = [];
  const runAgent = successfulRunner(logger, async (request) => { implemented.push(request.promptArgs.TICKET_ID!); });
  const config: ProcessConfig = { factoryRoot, harness: "pi", logger, providers, backlog, workflow, ledger, runAgent, maxParallel: 1, ticketAttemptsPerCycle: 1 };
  const state = createDependencyWorkflowState();
  assert.equal(await processDependencyCycle(config, state), "no-runnable");
  assert.equal(state.tickets.has("invalid"), true);
  assert.equal(state.tickets.has("duplicate"), true);

  const duplicateBody = backlog.issues.find((issue) => issue.number === 72)!.body;
  backlog.rewrite("invalid", "# Metadata was removed by its author");
  backlog.seed({ id: "duplicate-copy", number: 73, status: "Ready", body: duplicateBody });
  backlog.moveTo("invalid", "Ready");
  backlog.moveTo("duplicate", "Ready");
  backlog.moveTo("unrelated", "Ready");
  assert.equal(await processDependencyCycle(config, state), "processed");
  assert.deepEqual(implemented, ["unrelated"], "neither stale cached ticket is dispatched after fresh discovery rejects it");
  assert.equal(backlog.statusOf("unrelated"), "In review");
  assert.equal(backlog.statusOf("invalid"), "Ready");
  assert.equal(backlog.statusOf("duplicate"), "Blocked");
  assert.deepEqual(backlog.bodies("invalid"), []);
  assert.ok(backlog.bodies("duplicate").some((body) => body.includes("duplicate open ticket identity")));
  assert.equal(backlog.statusOf("duplicate-copy"), "Blocked");
  assert.equal(creates.length, 1);
  assert.match(creates[0]!.body, /Included: unrelated \(unrelated\)/);
});

test("an ordinary provider publication failure is isolated and unrelated work still publishes next cycle", async () => {
  const { factoryRoot, backlog, ledger, workflow, logger, providers, creates, failNextCreate } = await fixture([
    { id: "failed", number: 81, status: "Ready" },
    { id: "unrelated", number: 82, status: "Backlog" },
  ]);
  const runAgent = successfulRunner(logger);
  const config: ProcessConfig = { factoryRoot, harness: "pi", logger, providers, backlog, workflow, ledger, runAgent, maxParallel: 1, ticketAttemptsPerCycle: 1 };
  const state = createDependencyWorkflowState();
  failNextCreate();
  assert.equal(await processDependencyCycle(config, state), "processed", "a provider rejection is reported rather than escaping the coordinator");
  assert.equal(creates.length, 0);
  assert.notEqual(backlog.statusOf("failed"), "In review");
  assert.equal((await ledger.load()).results.length, 0);

  backlog.moveTo("unrelated", "Ready");
  assert.equal(await processDependencyCycle(config, state), "processed");
  assert.equal(backlog.statusOf("unrelated"), "In review");
  assert.equal(creates.length, 1);
  assert.match(creates[0]!.body, /Included: unrelated \(unrelated\)/);
  assert.ok(!creates[0]!.body.includes("failed (failed)"), "failed publication does not contaminate an unrelated draft");
});

test("authorization withdrawal preserves the human's board status on the next cycle", async () => {
  const { factoryRoot, backlog, ledger, workflow, logger, providers, creates } = await fixture([
    { id: "withdrawn", number: 91, status: "Ready" },
  ]);
  let implementations = 0;
  const runAgent = successfulRunner(logger, async () => {
    implementations++;
    backlog.moveTo("withdrawn", "Backlog");
  });
  const config: ProcessConfig = { factoryRoot, harness: "pi", logger, providers, backlog, workflow, ledger, runAgent, maxParallel: 1, ticketAttemptsPerCycle: 1 };
  const state = createDependencyWorkflowState();
  assert.equal(await processDependencyCycle(config, state), "processed");
  assert.equal(backlog.statusOf("withdrawn"), "Backlog");
  const preservation = backlog.bodies("withdrawn").filter((body) => body.includes("## Factory preserved unreviewed work"));
  assert.equal(preservation.length, 1);
  assert.match(preservation[0]!, /Authorization was withdrawn/);
  assert.equal(await processDependencyCycle(config, state), "no-runnable");
  assert.equal(backlog.statusOf("withdrawn"), "Backlog", "reporting the cached withdrawal must not move the human's status to Blocked");
  assert.deepEqual(backlog.transitions, ["withdrawn=In progress"]);
  assert.equal(backlog.bodies("withdrawn").filter((body) => body.includes("## Factory blocked")).length, 0);
  assert.equal(backlog.bodies("withdrawn").filter((body) => body.includes("## Factory preserved unreviewed work")).length, 1);
  assert.equal(implementations, 1);
  assert.equal(creates.length, 0);
});
