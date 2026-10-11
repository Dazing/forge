import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, runGit, CommandFailedError } from "../shared/git.js";
import type { Ticket } from "../tickets/tickets.js";
import { createWorkspace, reserveAttempt } from "./workspace-service.js";

const commitArgs = ["-c", "user.email=test@example.com", "-c", "user.name=Sandcastle Test"];

async function sourceRepository(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-source-"));
  const source = join(dir, "source");
  await runCommand("git", ["init", "-b", "main", source], "initializing source repository");
  await runGit(source, [...commitArgs, "commit", "--allow-empty", "-m", "main tip"], "creating main commit");
  await runGit(source, ["switch", "-c", "dev"], "creating dev branch");
  await runGit(source, [...commitArgs, "commit", "--allow-empty", "-m", "dev tip"], "creating dev commit");
  return source;
}

function ticket(repository: string, baseBranch: string): Ticket {
  return {
    id: "0123456789abcdef",
    name: "fix-login",
    slug: "fix-login",
    title: "Fix login",
    path: "/tmp/ticket.md",
    content: "Body.",
    repository,
    githubOwner: "acme",
    githubRepository: "app",
    baseBranch,
  };
}

test("clones the selected base branch and checks out the ticket branch", async () => {
  const source = await sourceRepository();
  const workspacesRoot = join(source, "../workspaces");
  const devTip = (await runGit(source, ["rev-parse", "dev"], "reading dev tip")).trim();

  const attempt = await createWorkspace(ticket(source, "dev"), await reserveAttempt(workspacesRoot, "fix-login"));

  assert.match(attempt.attemptId, /^[0-9a-f]{6}$/);
  assert.equal(attempt.branch, `agent-tickets/fix-login-${attempt.attemptId}`);
  assert.equal(attempt.workspacePath, join(workspacesRoot, `fix-login-${attempt.attemptId}`));

  const headBranch = (await runGit(attempt.workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"], "reading HEAD branch")).trim();
  assert.equal(headBranch, attempt.branch);
  assert.equal((await runGit(attempt.workspacePath, ["rev-parse", "HEAD"], "reading HEAD commit")).trim(), devTip);
  assert.equal(Number((await runGit(attempt.workspacePath, ["rev-list", "--count", "HEAD"], "counting history")).trim()), 2);
  assert.equal((await runGit(attempt.workspacePath, ["remote", "get-url", "origin"], "reading origin")).trim(), source);
});

test("a second attempt produces a distinct retained workspace", async () => {
  const source = await sourceRepository();
  const workspacesRoot = join(source, "../workspaces");

  const first = await createWorkspace(ticket(source, "main"), await reserveAttempt(workspacesRoot, "fix-login"));
  const second = await createWorkspace(ticket(source, "main"), await reserveAttempt(workspacesRoot, "fix-login"));

  assert.notEqual(first.attemptId, second.attemptId);
  assert.notEqual(first.workspacePath, second.workspacePath);
  assert.equal((await stat(first.workspacePath)).isDirectory(), true);
  assert.equal((await stat(second.workspacePath)).isDirectory(), true);
});

test("rejects an invalid base branch before cloning", async () => {
  const source = await sourceRepository();
  const workspace = await reserveAttempt(join(source, "../workspaces"), "fix-login");
  await assert.rejects(createWorkspace(ticket(source, "bad branch"), workspace), CommandFailedError);
});

test("clone failure leaves the reserved workspace directory in place", async () => {
  const source = await sourceRepository();
  const workspace = await reserveAttempt(join(source, "../workspaces"), "fix-login");
  const missing = join(source, "../not-a-repository");
  await assert.rejects(createWorkspace(ticket(missing, "main"), workspace), CommandFailedError);
  assert.equal((await stat(workspace.workspacePath)).isDirectory(), true);
});
