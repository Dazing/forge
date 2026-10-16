import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    assert.equal(facts.captureComplete, true);
    assert.equal(facts.captureFailure, undefined);
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

test("preservation captures tracked edits and untracked files in a runner-owned unfinished-work commit", async () => {
  const { root, workspacePath, remotePath } = await openRepository();
  try {
    await writeFile(join(workspacePath, "tracked.txt"), "original\n");
    await runGit(workspacePath, ["add", "tracked.txt"], "staging tracked fixture");
    await runGitAsRunner(workspacePath, ["commit", "-m", "tracked fixture"], "committing tracked fixture");
    const parent = (await runGit(workspacePath, ["rev-parse", "HEAD"], "reading pre-capture HEAD")).trim();
    await writeFile(join(workspacePath, "tracked.txt"), "unfinished tracked work\n");
    await writeFile(join(workspacePath, "new.txt"), "unfinished new work\n");
    const facts = await preserveAttemptWorkspace({ attemptId: "1a2b3c", branch: "factory/ticket-a-1a2b3c", repository: remotePath, baseBranch: "main", workspacePath, secrets: [] });
    assert.equal(facts.pushed, true);
    assert.equal(facts.captureComplete, true);
    assert.notEqual(facts.commitSha, parent);
    assert.equal((await runGit(remotePath, ["show", "refs/heads/factory/ticket-a-1a2b3c:tracked.txt"], "reading remote tracked work")), "unfinished tracked work\n");
    assert.equal((await runGit(remotePath, ["show", "refs/heads/factory/ticket-a-1a2b3c:new.txt"], "reading remote new work")), "unfinished new work\n");
    assert.equal((await runGit(workspacePath, ["rev-parse", "HEAD^"], "reading preservation parent")).trim(), parent);
    const metadata = await runGit(workspacePath, ["log", "-1", "--format=%an <%ae>%n%B"], "reading preservation metadata");
    assert.match(metadata, /Factory Runner <factory-runner@localhost>/);
    assert.doesNotMatch(metadata, /^Factory-(?:Outcome|Stage|Changes|Ticket|Attempt|Agent-Log):/m);
    assert.equal((await runGit(workspacePath, ["status", "--porcelain"], "reading retained status")).trim(), "");
    assert.equal((facts as unknown as Record<string, unknown>).secrets, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conflicted work preserves the last committed HEAD remotely and reports incomplete capture", async () => {
  const { root, workspacePath, remotePath } = await openRepository();
  try {
    await writeFile(join(workspacePath, "conflict.txt"), "original\n");
    await runGit(workspacePath, ["add", "conflict.txt"], "staging conflict fixture");
    await runGitAsRunner(workspacePath, ["commit", "-m", "conflict fixture"], "committing conflict fixture");
    await runGit(workspacePath, ["checkout", "-b", "other"], "creating conflicting branch");
    await writeFile(join(workspacePath, "conflict.txt"), "other\n");
    await runGit(workspacePath, ["add", "--all"], "staging other branch");
    await runGitAsRunner(workspacePath, ["commit", "-m", "other change"], "committing other branch");
    await runGit(workspacePath, ["checkout", "factory/ticket-a-1a2b3c"], "returning to attempt branch");
    await writeFile(join(workspacePath, "conflict.txt"), "attempt\n");
    await runGit(workspacePath, ["add", "--all"], "staging attempt branch");
    await runGitAsRunner(workspacePath, ["commit", "-m", "attempt change"], "committing attempt branch");
    await assert.rejects(runGitAsRunner(workspacePath, ["merge", "other"], "creating conflict"));
    const head = (await runGit(workspacePath, ["rev-parse", "HEAD"], "reading conflicted HEAD")).trim();
    const status = await runGit(workspacePath, ["status", "--porcelain"], "reading conflict status");
    const content = await readFile(join(workspacePath, "conflict.txt"), "utf8");
    const facts = await preserveAttemptWorkspace({ attemptId: "1a2b3c", branch: "factory/ticket-a-1a2b3c", repository: remotePath, baseBranch: "main", workspacePath, secrets: [] });
    assert.equal(facts.pushed, true);
    assert.equal(facts.captureComplete, false);
    assert.match(facts.captureFailure!, /Unresolved merge conflicts/);
    assert.equal(facts.commitSha, head);
    assert.equal((await runGit(remotePath, ["rev-parse", "refs/heads/factory/ticket-a-1a2b3c"], "reading preserved remote HEAD")).trim(), head);
    assert.equal(await runGit(workspacePath, ["status", "--porcelain"], "reading retained conflict status"), status);
    assert.equal(await readFile(join(workspacePath, "conflict.txt"), "utf8"), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("credential-bearing dirty work is retained locally but is never committed or pushed", async () => {
  const { root, workspacePath, remotePath, commitSha } = await openRepository();
  try {
    await writeFile(join(workspacePath, "credential.txt"), `unfinished ${SECRET}\n`);
    const facts = await preserveAttemptWorkspace({ attemptId: "1a2b3c", branch: "factory/ticket-a-1a2b3c", repository: remotePath, baseBranch: "main", workspacePath, secrets: [SECRET] });
    assert.equal(facts.pushed, true, "the safe pre-existing committed HEAD can still be retained remotely");
    assert.equal(facts.commitSha, commitSha);
    assert.equal(facts.captureComplete, false);
    assert.match(facts.captureFailure!, /credential material/);
    assert.ok(!JSON.stringify(facts).includes(SECRET));
    assert.equal(await readFile(join(workspacePath, "credential.txt"), "utf8"), `unfinished ${SECRET}\n`);
    await assert.rejects(runGit(remotePath, ["show", "refs/heads/factory/ticket-a-1a2b3c:credential.txt"], "checking remote credential absence"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed workspace branch is not published as the requested attempt branch", async () => {
  const { root, workspacePath, remotePath } = await openRepository();
  try {
    await runGit(workspacePath, ["checkout", "main"], "switching away from attempt branch");
    const facts = await preserveAttemptWorkspace({ attemptId: "1a2b3c", branch: "factory/ticket-a-1a2b3c", repository: remotePath, baseBranch: "main", workspacePath, secrets: [] });
    assert.equal(facts.pushed, false);
    assert.equal(facts.captureComplete, false);
    assert.match(facts.captureFailure!, /expected attempt branch/);
    assert.equal((await runGit(workspacePath, ["ls-remote", "origin", "refs/heads/factory/ticket-a-1a2b3c"], "checking wrong branch absence")).trim(), "");
    assert.equal((await runGit(workspacePath, ["branch", "--show-current"], "checking retained branch")).trim(), "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preservation refuses to replace a diverged remote branch", async () => {
  const { root, workspacePath, remotePath, commitSha } = await openRepository();
  try {
    await runGitAsRunner(workspacePath, ["push", "origin", "HEAD:refs/heads/factory/ticket-a-1a2b3c"], "publishing original attempt");
    await runGit(workspacePath, ["checkout", "-b", "diverged"], "creating diverged branch");
    await runGitAsRunner(workspacePath, ["commit", "--allow-empty", "-m", "remote-only work"], "committing remote-only work");
    const remoteHead = (await runGit(workspacePath, ["rev-parse", "HEAD"], "reading remote-only HEAD")).trim();
    await runGitAsRunner(workspacePath, ["push", "origin", "HEAD:refs/heads/factory/ticket-a-1a2b3c"], "advancing remote attempt");
    await runGit(workspacePath, ["checkout", "factory/ticket-a-1a2b3c"], "returning to local attempt");
    await writeFile(join(workspacePath, "local.txt"), "unfinished local work\n");
    const facts = await preserveAttemptWorkspace({ attemptId: "1a2b3c", branch: "factory/ticket-a-1a2b3c", repository: remotePath, baseBranch: "main", workspacePath, secrets: [] });
    assert.equal(facts.captureComplete, true);
    assert.equal(facts.pushed, false);
    assert.notEqual(facts.commitSha, commitSha, "local unfinished work remains captured even when push is refused");
    assert.equal((await runGit(remotePath, ["rev-parse", "refs/heads/factory/ticket-a-1a2b3c"], "checking remote work retained")).trim(), remoteHead);
    assert.equal(await runGit(workspacePath, ["show", "HEAD:local.txt"], "checking local work retained"), "unfinished local work\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("credential material in an existing commit withholds preservation push", async () => {
  const { root, workspacePath, remotePath } = await openRepository();
  try {
    await runGitAsRunner(workspacePath, ["commit", "--allow-empty", "-m", `unsafe ${SECRET}`], "creating unsafe existing commit");
    const facts = await preserveAttemptWorkspace({ attemptId: "1a2b3c", branch: "factory/ticket-a-1a2b3c", repository: remotePath, baseBranch: "main", workspacePath, secrets: [SECRET] });
    assert.equal(facts.pushed, false);
    assert.equal(facts.captureComplete, false);
    assert.match(facts.captureFailure!, /credential material/);
    assert.ok(!JSON.stringify(facts).includes(SECRET));
    assert.equal((await runGit(workspacePath, ["ls-remote", "origin", "refs/heads/factory/ticket-a-1a2b3c"], "checking unsafe branch absence")).trim(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
