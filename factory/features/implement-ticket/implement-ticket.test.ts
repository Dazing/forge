import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRequest, AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { MissingAgentHandoffError } from "../../infrastructure/agent-runtime/handoff.js";
import { runCommand } from "../../infrastructure/git-provider/git.js";
import type { Ticket } from "../tickets/index.js";
import { implementTicket, type ImplementTicketInput } from "./implement-ticket.js";
import { implementSchema } from "./implement-schema.js";


const ticket: Ticket = {
  id: "0123456789abcdef",
  sourceHash: "source",
  requirementsHash: "requirements",
  dependsOnTickets: [],
  name: "Fix Login",
  slug: "fix-login",
  title: "Fix login",
  path: "/tickets/fix-login.md",
  content: "# Fix login\n\nRedirect after auth.",
  repository: "git@github.com:acme/app.git",
  baseBranch: "main",
};

const BRANCH = "agent-tickets/fix-login-1";

function git(cwd: string, args: string[]): Promise<string> {
  return runCommand("git", ["-C", cwd, "-c", "user.email=implement@test", "-c", "user.name=Implement", ...args], `running git ${args[0]}`);
}

/** Real workspace on the ticket branch with one committed base file. */
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sandcastle-implement-"));
  await runCommand("git", ["init", "-b", "main", path], "initializing workspace");
  await writeFile(join(path, "README.md"), "# App\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "init"]);
  await git(path, ["switch", "-c", BRANCH]);
  return path;
}

function input(runAgent: AgentRunner, workspacePath: string): ImplementTicketInput {
  return { ticket, workspacePath, branch: BRANCH, attemptId: "1a2b3c", harness: "pi", runAgent };
}

/** Agent that leaves uncommitted stage work and submits a valid handoff. */
function completingAgent(message: string): AgentRunner {
  return async <TOutput>(request: AgentRunRequest<TOutput>) => {
    await writeFile(join(request.cwd, "login.ts"), "export const redirect = true;\n");
    return { iterations: [], commits: [], stdout: "", branch: BRANCH, logReference: "2026-10-12_09-30-15-1a2b3c/implement-1.log", handoff: { message } as TOutput } as AgentRunResult<TOutput>;
  };
}

test("implementation returns the validated stage message and leaves the work uncommitted", async () => {
  const workspacePath = await workspace();
  const requests: AgentRunRequest<unknown>[] = [];
  const runAgent = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    requests.push(request);
    return completingAgent("fix(login): redirect after auth\n\nTests passed.")(request);
  };

  const result = await implementTicket(input(runAgent, workspacePath));

  assert.equal(result.message, "fix(login): redirect after auth\n\nTests passed.");
  assert.equal(result.logReference, "2026-10-12_09-30-15-1a2b3c/implement-1.log", "the stage carries the transcript the runtime allocated");
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.maxIterations, 1);
  assert.equal(request.handoff.toolName, "submit_handoff");
  assert.deepEqual(request.logTarget, { scope: "attempt", attemptId: "1a2b3c", stage: "implement" });
  await access(request.promptFile);
  const status = (await git(workspacePath, ["status", "--porcelain"])).trim();
  assert.match(status, /\?\? login\.ts/);
});

test("implementation retries a failed iteration within the three-iteration limit", async () => {
  const workspacePath = await workspace();
  let runs = 0;
  const runAgent = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    runs += 1;
    if (runs === 1) {
      throw new MissingAgentHandoffError();
    }
    return { iterations: [], commits: [], stdout: "", branch: BRANCH, logReference: `1a2b3c/implement-${runs}.log`, handoff: { message: "fix(login): redirect after auth" } as TOutput } as AgentRunResult<TOutput>;
  };

  const result = await implementTicket(input(runAgent, workspacePath));

  assert.equal(result.message, "fix(login): redirect after auth");
  assert.equal(result.logReference, "1a2b3c/implement-2.log", "the retry carries its own transcript, not the failed run's");
  assert.equal(runs, 2);
});

test("implementation rejects after three omitted handoffs", async () => {
  const workspacePath = await workspace();
  let runs = 0;
  const runAgent = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    runs += 1;
    throw new MissingAgentHandoffError();
  };

  await assert.rejects(implementTicket(input(runAgent, workspacePath)), /implementation agent did not complete/);
  assert.equal(runs, 3);
});

test("implementation requires a clean stage-entry workspace", async () => {
  const workspacePath = await workspace();
  await writeFile(join(workspacePath, "leftover.ts"), "uncommitted\n");

  await assert.rejects(implementTicket(input(completingAgent("fix(login): redirect"), workspacePath)), /Implementation entry for ticket 0123456789abcdef left uncommitted changes/);
});

test("the stage message contract bounds, trims, and rejects forged runner trailers", () => {
  assert.deepEqual(implementSchema.parse({ message: "  fix(login): redirect after auth  " }), { message: "fix(login): redirect after auth" });
  assert.equal(implementSchema.safeParse({ message: "   " }).success, false);
  assert.equal(implementSchema.safeParse({ message: "x".repeat(4001) }).success, false);
  assert.equal(implementSchema.safeParse({ message: "fix: a\x00b" }).success, false);
  assert.equal(implementSchema.safeParse({ message: "fix: a\r\nb" }).success, false);
  assert.equal(implementSchema.safeParse({ message: "fix: a\nFactory-Stage: review" }).success, false);
  assert.equal(implementSchema.safeParse({ message: "fix: a", extra: "b" }).success, false);
});
