import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

function git(cwd: string, args: string[]): Promise<string> {
  return runCommand("git", ["-C", cwd, "-c", "user.email=attempt@test", "-c", "user.name=Attempt", ...args], `running git ${args[0]}`);
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
    validateRepository: (url) => {
      if (url !== remote) throw new Error(`Unsupported repository URL: ${url}`);
    },
    createDraftPullRequest: async () => ({ number: 1, url: "https://example.invalid/pull/1" }),
  };
}

/** Fake agent: implement/review complete silently; the pull-request content stage returns schema-shaped output. */
function fakeAgent(failStage?: "implement" | "review"): AgentRunner {
  return async <TOutput>(request: AgentRunRequest<TOutput>) => {
    const base = { iterations: [], commits: [], stdout: "", branch: "" };
    if (request.name.startsWith("implement-")) {
      await writeFile(join(request.cwd, "login.ts"), "export const redirect = true;\n");
      await git(request.cwd, ["add", "login.ts"]);
      await git(request.cwd, ["commit", "-m", "fix login redirect"]);
    }
    if (failStage !== undefined && request.name.startsWith(failStage)) {
      return { ...base, output: undefined } as unknown as AgentRunResult<TOutput>;
    }
    const output = request.name.startsWith("pull-request") ? { title: "Fix login redirect", body: "Verified with curl." } : undefined;
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
  const outcome = await executeAttempt(ticket, await config(ticketsDir, factoryRoot, remote, fakeAgent()));
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
  const outcome = await executeAttempt(ticket, await config(ticketsDir, factoryRoot, remote, fakeAgent("implement")));
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
  const outcome = await executeAttempt(ticket, await config(ticketsDir, factoryRoot, remote, fakeAgent("review")));
  assert.equal(outcome.completed, false);
  const annotated = await readFile(join(ticketsDir, "failed", "fix-login.md"), "utf8");
  assert.match(annotated, /Stage: `review`/);
});
