import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRequest, AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { runCommand } from "../../infrastructure/git-provider/git.js";
import type { GitProvider } from "../../infrastructure/git-provider/git-provider.js";
import { InvocationLogger } from "../../infrastructure/logging/invocation-log.js";
import { loadTicket, type Ticket } from "../tickets/index.js";
import { executeAttempt } from "./execute-attempt.js";
import type { ProcessConfig } from "./process-config.js";

const COMPLETE = "<promise>COMPLETE</promise>";
// Runner-owned checkpoint commits use the ambient identity; fixtures have none.
process.env.GIT_AUTHOR_NAME = "Attempt Test";
process.env.GIT_AUTHOR_EMAIL = "attempt@test.example";
process.env.GIT_COMMITTER_NAME = "Attempt Test";
process.env.GIT_COMMITTER_EMAIL = "attempt@test.example";

function git(cwd: string, args: string[], operation?: string): Promise<string> {
  return runCommand("git", ["-C", cwd, "-c", "user.email=attempt@test", "-c", "user.name=Attempt", ...args], operation ?? `running git ${args[0]}`);
}

/** Real fixture: bare remote with main, git factory root, ticket directory with one valid ticket. */
async function fixture(): Promise<{ ticketsDir: string; factoryRoot: string; remote: string }> {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-attempt-"));
  const remote = join(root, "remote.git");
  const factoryRoot = join(root, "factory");
  const ticketsDir = join(factoryRoot, "tickets");
  await runCommand("git", ["init", "--bare", remote], "creating bare remote");
  const seed = join(root, "seed");
  await runCommand("git", ["clone", remote, seed], "cloning empty remote");
  await git(seed, ["checkout", "-B", "main"]);
  await writeFile(join(seed, "README.md"), "# App\n");
  await git(seed, ["add", "README.md"]);
  await git(seed, ["commit", "-m", "init"]);
  await git(seed, ["push", "origin", "main"]);
  await runCommand("git", ["init", factoryRoot], "initializing factory root");
  await writeFile(join(factoryRoot, "README.md"), "# Factory\n");
  await git(factoryRoot, ["add", "README.md"]);
  await git(factoryRoot, ["commit", "-m", "factory init"]);
  await mkdir(ticketsDir);
  return { ticketsDir, factoryRoot, remote };
}

function writeTicket(ticketsDir: string, remote: string): Promise<string> {
  const path = join(ticketsDir, "fix-login.md");
  return writeFile(path, `---\nname: Fix login\nrepository: ${remote}\nbaseBranch: main\n---\n\n# Fix login\n\nRedirect after auth.\n`).then(() => path);
}

function localProvider(remote: string): GitProvider {
  return {
    name: "github",
    credential: "gh_secret_abc",
    mergeStrategySupport: "unsupported",
    validateRepository: (url) => {
      if (url !== remote) throw new Error(`Unsupported repository URL: ${url}`);
    },
    createDraftPullRequest: async () => ({ number: 1, url: "https://example.invalid/pull/1", squashPreference: "unsupported" }),
    secrets: () => ["gh_secret_abc"],
  };
}

interface FakeOptions {
  failStage?: "implement" | "review";
  switchAwayOn?: "implement" | "review";
  skipChanges?: boolean;
  breakTicketOn?: "implement" | "review";
  ticketPath?: string;
  calls: string[];
}

/** Fake stage agents: implement/review leave uncommitted work and return structured messages; pull-request content returns schema-shaped output. */
function fakeAgent(options: FakeOptions): AgentRunner {
  return async <TOutput>(request: AgentRunRequest<TOutput>) => {
    const stage = request.name.startsWith("implement-") ? "implement" : request.name.startsWith("review-") ? "review" : request.name.startsWith("pull-request-") ? "pull-request" : "other";
    options.calls.push(request.name);
    if (stage === "implement" && !options.skipChanges) {
      await writeFile(join(request.cwd, "login.ts"), "export const redirect = true;\n");
    }
    if (stage === "review") {
      await writeFile(join(request.cwd, "review-note.md"), "reviewed\n");
    }
    if (options.switchAwayOn === stage) {
      await git(request.cwd, ["switch", "-c", "side-branch"]);
    }
    if (options.breakTicketOn === stage && options.ticketPath !== undefined) {
      await rm(options.ticketPath, { recursive: true });
      await mkdir(options.ticketPath);
    }
    const base = { iterations: [], commits: [], stdout: "", branch: "" };
    if (options.failStage === stage) {
      return { ...base, output: undefined } as unknown as AgentRunResult<TOutput>;
    }
    const output = stage === "pull-request"
      ? { title: "Fix login redirect", body: "Verified with curl." }
      : { message: stage === "implement" ? "Add redirect after auth." : "Reviewed; no findings." };
    return { ...base, completionSignal: COMPLETE, output } as unknown as AgentRunResult<TOutput>;
  };
}

async function config(ticketsDir: string, factoryRoot: string, remote: string, runAgent: AgentRunner): Promise<ProcessConfig> {
  return {
    ticketsDir,
    factoryRoot,
    harness: "pi",
    logger: await InvocationLogger.create(factoryRoot, "gh_secret_abc"),
    gitProvider: localProvider(remote),
    runAgent,
  };
}

test("a successful attempt completes the ticket, annotates completion, and pushes the branch", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const outcome = await executeAttempt(ticket, await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls: [] })));
  assert.equal(outcome.completed, true);
  assert.match(outcome.destination, /tickets\/done\/fix-login\.md$/);
  const annotated = await readFile(outcome.destination, "utf8");
  assert.match(annotated, new RegExp("Attempt ID: `" + outcome.attemptId + "`"));
  assert.match(annotated, /Draft PR: https:\/\/example\.invalid\/pull\/1/);
  assert.match(annotated, /Final commit: `[0-9a-f]{40}`/);
  const pushed = await git(remote, ["rev-parse", `refs/heads/agent-tickets/fix-login-${outcome.attemptId}`]);
  assert.match(pushed.trim(), /^[0-9a-f]{40}$/);
});

test("a failed attempt records the stage, annotates the failure, and moves the ticket to failed/", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const outcome = await executeAttempt(ticket, await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls: [], failStage: "implement" })));
  assert.equal(outcome.completed, false);
  assert.match(outcome.destination, /tickets\/failed\/fix-login\.md$/);
  const annotated = await readFile(outcome.destination, "utf8");
  assert.match(annotated, /Stage: `implement`/);
  assert.match(annotated, /Attempt ID: `[0-9a-f]{6}`/);
});

test("a review failure settles to failed/ with the review stage", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const outcome = await executeAttempt(ticket, await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls: [], failStage: "review" })));
  assert.equal(outcome.completed, false);
  const annotated = await readFile(join(ticketsDir, "failed", "fix-login.md"), "utf8");
  assert.match(annotated, /Stage: `review`/);
});

function workspaceOf(annotated: string): string {
  return annotated.match(/- Workspace: `([^`]+)`/)![1]!;
}

function commitsAhead(workspace: string): Promise<string> {
  return git(workspace, ["rev-list", "--count", "origin/main..HEAD"], "counting commits ahead").then((out) => out.trim());
}

test("successful attempt records implementation and review checkpoints with parent and checkpoint SHAs", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const calls: string[] = [];
  const cfg = await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls }));
  const outcome = await executeAttempt(ticket, cfg);
  const annotated = await readFile(outcome.destination, "utf8");

  const implement = annotated.match(/## Stage checkpoint implement [\s\S]*?- Parent commit: `([0-9a-f]{40})`\n- Checkpoint commit: `([0-9a-f]{40})`\n- Changes: changed/);
  const review = annotated.match(/## Stage checkpoint review [\s\S]*?- Parent commit: `([0-9a-f]{40})`\n- Checkpoint commit: `([0-9a-f]{40})`\n- Changes: changed/);
  assert.ok(implement && review, "both stage checkpoints are annotated");
  assert.equal(review![1], implement![2], "the review checkpoint starts from the implementation checkpoint");
  assert.equal(annotated.match(/Final commit: `([0-9a-f]{40})`/)![1], review![2], "the final SHA is the review checkpoint");
  assert.deepEqual(calls.map((n) => n.split("-")[0]), ["implement", "review", "pull"]);

  const log = await readFile(join(cfg.logger.runDir, "main.log"), "utf8");
  assert.match(log, new RegExp(`stage=implementation commit operation=creating stage checkpoint commit status=completed parent=${implement![1]} checkpoint=${implement![2]} changes=changed agent-log=implement-${ticket.id}-${outcome.attemptId}\.log`));
  assert.match(log, new RegExp(`stage=review commit operation=creating stage checkpoint commit status=completed parent=${review![1]} checkpoint=${review![2]} changes=changed agent-log=review-${ticket.id}-${outcome.attemptId}\.log`));
  assert.match(log, new RegExp(`stage=pull-request content operation=generating pull-request content status=completed checkpoint=${review![2]} changes=unchanged agent-log=pull-request-${ticket.id}-${outcome.attemptId}\.log`));
});

test("a checkpoint failure after implementation settles with the implementation commit stage and stops further stages", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const calls: string[] = [];

  const outcome = await executeAttempt(ticket, await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls, switchAwayOn: "implement" })));

  assert.equal(outcome.completed, false);
  assert.match(outcome.destination, /tickets\/failed\/fix-login\.md$/);
  const annotated = await readFile(outcome.destination, "utf8");
  assert.match(annotated, /Stage: `implementation commit`/);
  assert.ok(!calls.some((n) => n.startsWith("review-")), "the review stage never runs after a failed checkpoint");
  const workspace = workspaceOf(annotated);
  assert.match(await readFile(join(workspace, "login.ts"), "utf8"), /redirect/, "the uncommitted implementation work is retained");
  assert.equal(await commitsAhead(workspace), "0", "no checkpoint commit is created for a failed boundary");
});

test("a checkpoint failure after review settles with the review commit stage and stops publication", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const calls: string[] = [];

  const outcome = await executeAttempt(ticket, await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls, switchAwayOn: "review" })));

  assert.equal(outcome.completed, false);
  const annotated = await readFile(outcome.destination, "utf8");
  assert.match(annotated, /Stage: `review commit`/);
  assert.ok(!calls.some((n) => n.startsWith("pull-request-")), "publication never runs after a failed review checkpoint");
  const workspace = workspaceOf(annotated);
  assert.equal(await commitsAhead(workspace), "1", "the implementation checkpoint is retained");
});

test("a stage that changed no files records an unchanged empty checkpoint", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const calls: string[] = [];
  const cfg = await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls, skipChanges: true }));

  const outcome = await executeAttempt(ticket, cfg);
  const annotated = await readFile(outcome.destination, "utf8");
  const implement = annotated.match(/## Stage checkpoint implement [\s\S]*?- Checkpoint commit: `([0-9a-f]{40})`\n- Changes: unchanged/);
  assert.ok(implement, "the empty implementation checkpoint is annotated as unchanged");
  const log = await readFile(join(cfg.logger.runDir, "main.log"), "utf8");
  assert.match(log, new RegExp(`stage=implementation commit operation=creating stage checkpoint commit status=completed parent=[0-9a-f]{40} checkpoint=${implement![1]} changes=unchanged`));
});

test("a stage checkpoint annotation failure stops further stages without retrying the commit", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const calls: string[] = [];
  const cfg = await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls, breakTicketOn: "implement", ticketPath: path }));

  const outcome = await executeAttempt(ticket, cfg);

  assert.equal(outcome.completed, false);
  const log = await readFile(join(cfg.logger.runDir, "main.log"), "utf8");
  assert.match(log, /stage=implementation checkpoint annotation operation=annotating stage checkpoint status=failed/);
  assert.ok(!calls.some((n) => n.startsWith("review-")), "the review stage never runs after an annotation failure");
  const workspace = join(factoryRoot, ".workspaces");
  const entries = await readdir(workspace);
  const single = entries.filter((name) => name.startsWith("fix-login-"));
  assert.equal(single.length, 1);
  assert.equal(await commitsAhead(join(workspace, single[0]!)), "1", "the checkpoint commit is retained and never repeated");
});

test("a content trace failure settles before push or draft publication", async (t) => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  t.after(() => rm(join(factoryRoot, ".."), { recursive: true, force: true }));
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const cfg = await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls: [] }));
  const record = cfg.logger.record.bind(cfg.logger);
  t.mock.method(cfg.logger, "record", async (entry: Parameters<InvocationLogger["record"]>[0]) => {
    if (entry.stage === "pull-request content" && entry.status === "completed") {
      throw new Error("content trace unavailable");
    }
    await record(entry);
  });
  let published = false;
  t.mock.method(cfg.gitProvider, "createDraftPullRequest", async () => {
    published = true;
    return { number: 1, url: "https://example.invalid/pull/1", squashPreference: "unsupported" as const };
  });

  const outcome = await executeAttempt(ticket, cfg);

  assert.equal(outcome.completed, false);
  assert.match(outcome.destination, /tickets\/failed\/fix-login\.md$/);
  assert.match(await readFile(outcome.destination, "utf8"), /Stage: `pull-request content`/);
  assert.equal(published, false);
  assert.equal((await git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/agent-tickets/"])).trim(), "");
});

test("published attempts stay completed when terminal movement and settlement logging fail", async (t) => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  t.after(() => rm(join(factoryRoot, ".."), { recursive: true, force: true }));
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const cfg = await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls: [] }));
  let publications = 0;
  t.mock.method(cfg.gitProvider, "createDraftPullRequest", async () => {
    publications++;
    await writeFile(join(ticketsDir, "done"), "movement blocked");
    await rm(join(cfg.logger.runDir, "main.log"));
    await mkdir(join(cfg.logger.runDir, "main.log"));
    return { number: 1, url: "https://example.invalid/pull/1", squashPreference: "unsupported" as const };
  });

  const outcome = await executeAttempt(ticket, cfg);

  assert.equal(outcome.completed, true);
  assert.equal(outcome.destination, "");
  assert.equal(publications, 1);
  const annotated = await readFile(path, "utf8");
  assert.match(annotated, /Draft PR: https:\/\/example\.invalid\/pull\/1/);
  assert.doesNotMatch(annotated, /## Failed/);
  const finalSha = annotated.match(/Final commit: `([0-9a-f]{40})`/)![1]!;
  assert.equal((await git(remote, ["rev-parse", `refs/heads/agent-tickets/fix-login-${outcome.attemptId}`])).trim(), finalSha);
});

test("a persistent checkpoint log failure retains one commit and still settles the ticket", async (t) => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  t.after(() => rm(join(factoryRoot, ".."), { recursive: true, force: true }));
  const path = await writeTicket(ticketsDir, remote);
  const ticket = await loadTicket(path, localProvider(remote));
  const calls: string[] = [];
  const cfg = await config(ticketsDir, factoryRoot, remote, fakeAgent({ calls }));
  await mkdir(join(cfg.logger.runDir, "main.log"));

  const outcome = await executeAttempt(ticket, cfg);

  assert.equal(outcome.completed, false);
  assert.match(outcome.destination, /tickets\/failed\/fix-login\.md$/);
  const annotated = await readFile(outcome.destination, "utf8");
  assert.match(annotated, /Stage: `implementation commit`/);
  assert.match(annotated, /EISDIR/);
  assert.equal(await commitsAhead(workspaceOf(annotated)), "1");
  assert.equal(calls.some((name) => name.startsWith("review-") || name.startsWith("pull-request-")), false);
  assert.equal((await git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/agent-tickets/"])).trim(), "");
});
