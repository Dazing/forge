import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectAuthorizationLapse, preserveAttemptWorkspace } from "./authorization-lapse.js";
import { runGit, runGitAsRunner } from "../../infrastructure/git-provider/git.js";

const SECRET = "ghp_supersensitivecredential";

test("lapse recognition names the reporting side for each provider and transport", () => {
  const cases: readonly [string, string][] = [
    ["GitHub API returned 403: Resource not accessible by personal access token", "github"],
    ["gh: Resource not accessible by integration", "github"],
    ["PUT https://api.github.com/repos/acme/app/pulls: 403 Forbidden", "github"],
    ["GitHub API returned 401: Bad credentials", "github"],
    ["remote: This repository requires SAML authorization", "github"],
    ["TF401027: You need the Git 'Push' permission to perform this action.", "azure-devops"],
    ["TF400813: The user is not authorized to access this resource.", "azure-devops"],
    ["The provided Azure DevOps token lacks the vso.code_write scope.", "azure-devops"],
    ["git@github.com: Permission denied (publickey).", "git"],
    ["fatal: could not read Username for 'https://dev.azure.com': terminal prompts disabled", "git"],
    ["The requested url returned error: 403, module 'git/repository' does not support HTTP GET", "git"],
  ];
  for (const [report, source] of cases) {
    const lapse = detectAuthorizationLapse(report);
    assert.notEqual(lapse, undefined, report);
    assert.equal(lapse!.source, source, report);
    assert.ok(lapse!.detail.length > 0, report);
  }
});

test("ordinary work failures are not authorization lapses", () => {
  for (const report of [
    "npm test exited 1: 3 assertions failed",
    "CONFLICT (content): Merge conflict in src/app.ts",
    "error: The sandbox is not available: docker daemon is not running",
    "Agent handoff was not submitted within the iteration limit.",
    "fatal: unable to access https://github.com: Failed to connect to github.com port 443",
  ]) {
    assert.equal(detectAuthorizationLapse(report), undefined, report);
  }
});

test("the published lapse detail never carries a credential", () => {
  const lapse = detectAuthorizationLapse(
    `Authorization failed for ${SECRET}\nGitHub API returned 403: Resource not accessible by personal access token`,
    [SECRET],
  );
  assert.equal(lapse!.source, "github");
  assert.ok(!lapse!.detail.includes(SECRET), lapse!.detail);
  assert.ok(lapse!.detail.length <= 240, lapse!.detail);
});

async function openRepository(): Promise<Readonly<{ root: string; workspacePath: string; remotePath: string; commitSha: string }>> {
  const root = await mkdtemp(join(tmpdir(), "lapse-preserve-"));
  const remotePath = join(root, "remote.git");
  const workspacePath = join(root, "workspace");
  await runGit(root, ["init", "--bare", remotePath], "creating the bare remote");
  await runGitAsRunner(root, ["clone", remotePath, workspacePath], "cloning the empty remote");
  await runGit(workspacePath, ["checkout", "-b", "main"], "creating the base branch");
  await runGitAsRunner(workspacePath, ["commit", "--allow-empty", "-m", "base"], "creating the base commit");
  await runGitAsRunner(workspacePath, ["push", "origin", "main"], "publishing the base branch");
  await runGit(workspacePath, ["checkout", "-b", "factory/ticket-a-1a2b3c"], "creating the attempt branch");
  await runGitAsRunner(workspacePath, ["commit", "--allow-empty", "-m", "preserved work"], "creating the preserved commit");
  const commitSha = (await runGit(workspacePath, ["rev-parse", "HEAD"], "reading HEAD")).trim();
  return { root, workspacePath, remotePath, commitSha };
}

test("preservation pushes the attempt branch without touching the base branch", async () => {
  const { root, workspacePath, remotePath, commitSha } = await openRepository();
  try {
    const facts = await preserveAttemptWorkspace({
      attemptId: "1a2b3c",
      branch: "factory/ticket-a-1a2b3c",
      repository: remotePath,
      baseBranch: "main",
      workspacePath,
      secrets: [],
    });
    assert.equal(facts.pushed, true);
    assert.equal(facts.pushFailure, undefined);
    assert.equal(facts.commitSha, commitSha);
    const pushed = (await runGit(workspacePath, ["ls-remote", "origin", "refs/heads/factory/ticket-a-1a2b3c"], "reading the pushed branch")).trim();
    assert.ok(pushed.startsWith(commitSha), pushed);
    const base = (await runGit(workspacePath, ["ls-remote", "origin", "refs/heads/main"], "reading the base branch")).trim();
    assert.ok(!base.startsWith(commitSha), base);
    assert.equal((await runGit(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"], "reading HEAD branch")).trim(), "factory/ticket-a-1a2b3c");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a push the remote refuses is reported, and the retained workspace is left intact", async () => {
  const { root, workspacePath, commitSha } = await openRepository();
  try {
    await runGit(workspacePath, ["remote", "set-url", "origin", join(root, "gone.git")], "withdrawing the remote");
    const facts = await preserveAttemptWorkspace({
      attemptId: "1a2b3c",
      branch: "factory/ticket-a-1a2b3c",
      repository: join(root, "gone.git"),
      baseBranch: "main",
      workspacePath,
      secrets: [],
    });
    assert.equal(facts.pushed, false);
    assert.ok(facts.pushFailure !== undefined && facts.pushFailure.length > 0);
    assert.equal(facts.commitSha, commitSha);
    assert.equal((await runGit(workspacePath, ["rev-parse", "HEAD"], "reading HEAD")).trim(), commitSha);
    assert.equal((await runGit(workspacePath, ["status", "--porcelain"], "reading status")).trim(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
