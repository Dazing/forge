import { access } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRequest, AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import type { Ticket } from "../tickets/index.js";
import { implementTicket, type ImplementTicketInput } from "./implement-ticket.js";

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

function input(runAgent: AgentRunner): ImplementTicketInput {
  return { ticket, workspacePath: "/workspaces/fix-login-1", branch: "agent-tickets/fix-login-1", attemptId: "1", harness: "pi", runAgent };
}

test("implementation completes when the agent emits the completion signal", async () => {
  const requests: AgentRunRequest<undefined>[] = [];
  const runAgent = async <TOutput>(request: AgentRunRequest<TOutput>) => {
    requests.push(request as AgentRunRequest<undefined>);
    return { iterations: [], commits: [], stdout: "", branch: "agent-tickets/fix-login-1", completionSignal: "<promise>COMPLETE</promise>", output: undefined as TOutput };
  };
  await implementTicket(input(runAgent));
  const request = requests[0]!;
  assert.equal(request.maxIterations, 3);
  assert.equal(request.completionSignal, "<promise>COMPLETE</promise>");
  await access(request.promptFile);
});

test("implementation rejects when the agent never completes", async () => {
  const runAgent = async <TOutput>(request: AgentRunRequest<TOutput>) => ({
    iterations: [],
    commits: [],
    stdout: "",
    branch: "agent-tickets/fix-login-1",
    output: undefined as TOutput,
  });
  await assert.rejects(implementTicket(input(runAgent)), /implementation agent did not complete/);
});
