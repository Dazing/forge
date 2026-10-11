import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../../infrastructure/git-provider/git.js";
import type { AgentRunRequest, AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import type { Ticket } from "../tickets/index.js";
import { reviewTicket, type ReviewTicketInput } from "./review-ticket.js";

const ticket: Ticket = {
  id: "0123456789abcdef",
  name: "Fix Login",
  slug: "fix-login",
  title: "Fix login",
  path: "/tickets/fix-login.md",
  content: "# Fix login\n\nRedirect after auth.",
  repository: "git@github.com:acme/app.git",
  baseBranch: "main",
};

function completedRunAgent(): AgentRunner {
  return async <TOutput>(request: AgentRunRequest<TOutput>) => ({
    iterations: [],
    commits: [],
    stdout: "",
    branch: "agent-tickets/fix-login-1",
    completionSignal: "<promise>COMPLETE</promise>",
    output: undefined as TOutput,
  });
}

function input(runAgent: AgentRunner, workspacePath: string): ReviewTicketInput {
  return { ticket, workspacePath, branch: "agent-tickets/fix-login-1", attemptId: "1", harness: "pi", runAgent };
}

async function cleanWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "sandcastle-review-"));
  await runCommand("git", ["init", "-b", "main", workspace], "initializing review workspace");
  await writeFile(join(workspace, "app.ts"), "export const login = true;\n");
  await runCommand("git", ["-C", workspace, "add", "app.ts"], "staging file");
  await runCommand("git", ["-C", workspace, "-c", "user.email=review@test", "-c", "user.name=Review", "commit", "-m", "init"], "committing file");
  return workspace;
}

test("review passes on a clean workspace when the agent completes", async () => {
  const workspace = await cleanWorkspace();
  await reviewTicket(input(completedRunAgent(), workspace));
});

test("review rejects when the agent never completes", async () => {
  const workspace = await cleanWorkspace();
  const runAgent = async <TOutput>(request: AgentRunRequest<TOutput>) => ({
    iterations: [],
    commits: [],
    stdout: "",
    branch: "agent-tickets/fix-login-1",
    output: undefined as TOutput,
  });
  await assert.rejects(reviewTicket(input(runAgent, workspace)), /review agent did not complete/);
});

test("review rejects a workspace left dirty by the review agent", async () => {
  const workspace = await cleanWorkspace();
  const runAgent = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    await writeFile(join(workspace, "leftover.ts"), "uncommitted\n");
    return { iterations: [], commits: [], stdout: "", branch: "agent-tickets/fix-login-1", completionSignal: "<promise>COMPLETE</promise>", output: undefined as TOutput };
  };
  await assert.rejects(reviewTicket(input(runAgent, workspace)), /Review for ticket 0123456789abcdef left uncommitted changes/);
});
