import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRequest, AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { runCommand } from "../../infrastructure/git-provider/git.js";
import type { GitProvider } from "../../infrastructure/git-provider/git-provider.js";
import { InvocationLogger } from "../../infrastructure/logging/invocation-log.js";
import { loadTicket, type Ticket } from "../tickets/index.js";
import { processIteration } from "./process-iteration.js";
import { processTickets } from "./process-tickets.js";
import type { ProcessConfig } from "./process-config.js";

const COMPLETE = "<promise>COMPLETE</promise>";

function git(cwd: string, args: string[]): Promise<string> {
  return runCommand("git", ["-C", cwd, "-c", "user.email=iteration@test", "-c", "user.name=Iteration", ...args], `running git ${args[0]}`);
}

async function fixture(): Promise<{ ticketsDir: string; factoryRoot: string; remote: string }> {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-iteration-"));
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

/** Fake workflow: the planner selects `ticketId`; implement/review complete silently; content returns schema output. */
function fakeWorkflow(ticketId: string, failStage?: "implement"): AgentRunner {
  return async <TOutput>(request: AgentRunRequest<TOutput>) => {
    const base = { iterations: [], commits: [], stdout: "", branch: "" };
    if (request.name === "plan") {
      return { ...base, completionSignal: "</plan>", output: { tickets: [{ id: ticketId, title: "Fix login" }] } } as unknown as AgentRunResult<TOutput>;
    }
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

test("an invalid metadata ticket settles to failed/ and the iteration returns no outcomes", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = join(ticketsDir, "broken.md");
  await writeFile(path, "---\nname: Broken ticket\nbaseBranch: main\n---\n\nNo repository line.\n");
  const known = new Map<string, Ticket>();
  const terminal = new Set<string>();
  const outcomes = await processIteration(await config(ticketsDir, factoryRoot, remote, fakeWorkflow("0123456789abcdef")), known, terminal);
  assert.deepEqual(outcomes, []);
  const settled = await readFile(join(ticketsDir, "failed", "broken.md"), "utf8");
  assert.match(settled, /Stage: `ticket metadata`/);
  assert.equal(known.size, 0);
  assert.equal(terminal.size, 0);
});

test("a valid ticket is planned, executed, and recorded as terminal so the next iteration skips it", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = join(ticketsDir, "fix-login.md");
  await writeFile(path, `---\nname: Fix login\nrepository: ${remote}\nbaseBranch: main\n---\n\n# Fix login\n\nRedirect after auth.\n`);
  const ticket = await loadTicket(path, localProvider(remote));
  const known = new Map<string, Ticket>();
  const terminal = new Set<string>();
  const outcomes = await processIteration(await config(ticketsDir, factoryRoot, remote, fakeWorkflow(ticket.id)), known, terminal);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.completed, true);
  assert.equal(outcomes[0]!.ticketId, ticket.id);
  assert.ok(terminal.has(ticket.id));
  assert.equal(known.size, 0);
  await readFile(join(ticketsDir, "done", "fix-login.md"), "utf8");

  // Re-discovering the same ticket file must not reprocess it: terminal bookkeeping suppresses it.
  await writeFile(path, `---\nname: Fix login\nrepository: ${remote}\nbaseBranch: main\n---\n\n# Fix login\n\nRedirect after auth.\n`);
  const second = await processIteration(await config(ticketsDir, factoryRoot, remote, fakeWorkflow(ticket.id)), known, terminal);
  assert.deepEqual(second, []);
  assert.equal(known.size, 0);
  assert.ok(terminal.has(ticket.id));
});

test("a failed attempt is recorded as terminal and settles to failed/", async () => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  const path = join(ticketsDir, "fix-login.md");
  await writeFile(path, `---\nname: Fix login\nrepository: ${remote}\nbaseBranch: main\n---\n\n# Fix login\n\nRedirect after auth.\n`);
  const ticket = await loadTicket(path, localProvider(remote));
  const known = new Map<string, Ticket>();
  const terminal = new Set<string>();
  const outcomes = await processIteration(await config(ticketsDir, factoryRoot, remote, fakeWorkflow(ticket.id, "implement")), known, terminal);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.completed, false);
  assert.ok(terminal.has(ticket.id));
  const settled = await readFile(join(ticketsDir, "failed", "fix-login.md"), "utf8");
  assert.match(settled, /Stage: `implement`/);
});

test("the daemon plans again without sleeping when an empty selection leaves a pending ticket", async (t) => {
  const { ticketsDir, factoryRoot, remote } = await fixture();
  t.after(() => rm(join(factoryRoot, ".."), { recursive: true, force: true }));
  await writeFile(join(ticketsDir, "fix-login.md"), `---\nname: Fix login\nrepository: ${remote}\n---\n\n# Fix login\n`);
  const stop = new Error("bounded daemon stop");
  let plans = 0;
  const runAgent: AgentRunner = async <TOutput>() => {
    if (++plans === 2) throw stop;
    return { iterations: [], commits: [], stdout: "", branch: "", completionSignal: "</plan>", output: { tickets: [] } as TOutput };
  };
  const options = await config(ticketsDir, factoryRoot, remote, runAgent);
  t.mock.method(globalThis, "setTimeout", () => {
    throw new Error("polling must not sleep while a ticket remains pending");
  });
  await assert.rejects(processTickets(options), (error: unknown) => {
    assert.equal(error, stop);
    return true;
  });
  assert.equal(plans, 2);
});
