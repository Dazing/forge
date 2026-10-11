import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRequest, AgentRunner, AgentRunResult } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { StructuredOutputError } from "@ai-hero/sandcastle";
import { runCommand } from "../../infrastructure/git-provider/git.js";
import type { Ticket } from "../tickets/index.js";
import { reviewTicket, type ReviewTicketInput } from "./review-ticket.js";
import { reviewSchema } from "./review-schema.js";

const COMPLETE = "<promise>COMPLETE</promise>";

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
  return runCommand("git", ["-C", cwd, "-c", "user.email=review@test", "-c", "user.name=Review", ...args], `running git ${args[0]}`);
}

/** Real workspace on the ticket branch with one committed base file. */
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sandcastle-review-"));
  await runCommand("git", ["init", "-b", "main", path], "initializing workspace");
  await writeFile(join(path, "README.md"), "# App\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "init"]);
  await git(path, ["switch", "-c", BRANCH]);
  return path;
}

function input(runAgent: AgentRunner, workspacePath: string): ReviewTicketInput {
  return { ticket, workspacePath, branch: BRANCH, attemptId: "1a2b3c", harness: "pi", runAgent };
}

test("review returns the validated message and accepts the uncommitted work under review", async () => {
  const workspacePath = await workspace();
  const requests: AgentRunRequest<unknown>[] = [];
  const runAgent = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    requests.push(request);
    await writeFile(join(request.cwd, "login.ts"), "export const redirect = true;\n");
    return { iterations: [], commits: [], stdout: "", branch: BRANCH, completionSignal: COMPLETE, output: { message: "fix(login): review approved" } as TOutput } as AgentRunResult<TOutput>;
  };

  const result = await reviewTicket(input(runAgent, workspacePath));

  assert.equal(result.message, "fix(login): review approved");
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.maxIterations, 1);
  assert.equal(request.completionSignal, COMPLETE);
  assert.equal(request.output?.tag, "review");
  const status = (await git(workspacePath, ["status", "--porcelain"])).trim();
  assert.match(status, /\?\? login\.ts/);
});

test("review retries a failed iteration within the three-iteration limit", async () => {
  const workspacePath = await workspace();
  let runs = 0;
  const runAgent = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    runs += 1;
    if (runs === 1) {
      throw new StructuredOutputError("Structured output validation failed: blank message", { tag: "review", rawMatched: undefined, commits: [], branch: BRANCH });
    }
    return { iterations: [], commits: [], stdout: "", branch: BRANCH, completionSignal: COMPLETE, output: { message: "fix(login): review approved" } as TOutput } as AgentRunResult<TOutput>;
  };

  const result = await reviewTicket(input(runAgent, workspacePath));

  assert.equal(result.message, "fix(login): review approved");
  assert.equal(runs, 2);
});

test("review rejects after three iterations without a completion signal", async () => {
  const workspacePath = await workspace();
  let runs = 0;
  const runAgent = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    runs += 1;
    return { iterations: [], commits: [], stdout: "", branch: BRANCH, output: undefined as TOutput } as AgentRunResult<TOutput>;
  };

  await assert.rejects(reviewTicket(input(runAgent, workspacePath)), /review agent did not complete/);
  assert.equal(runs, 3);
});

test("review requires a clean stage-entry workspace", async () => {
  const workspacePath = await workspace();
  await writeFile(join(workspacePath, "leftover.ts"), "uncommitted\n");

  await assert.rejects(
    reviewTicket(input(async <TOutput>(request: AgentRunRequest<TOutput>) => {
      return { iterations: [], commits: [], stdout: "", branch: BRANCH, completionSignal: COMPLETE, output: { message: "fix(login): review approved" } as TOutput } as AgentRunResult<TOutput>;
    }, workspacePath)),
    /Review entry for ticket 0123456789abcdef left uncommitted changes/,
  );
});

test("the review message contract bounds, trims, and rejects forged runner trailers", () => {
  assert.deepEqual(reviewSchema.parse({ message: "  fix(login): review approved  " }), { message: "fix(login): review approved" });
  assert.equal(reviewSchema.safeParse({ message: "   " }).success, false);
  assert.equal(reviewSchema.safeParse({ message: "x".repeat(4001) }).success, false);
  assert.equal(reviewSchema.safeParse({ message: "fix: a\x00b" }).success, false);
  assert.equal(reviewSchema.safeParse({ message: "fix: a\nFactory-Attempt: deadbeef" }).success, false);
  assert.equal(reviewSchema.safeParse({ message: "fix: a", extra: "b" }).success, false);
});
