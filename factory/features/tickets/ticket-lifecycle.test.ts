import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { annotateAttempt, annotateCompletion, annotateFailure, annotateStageCheckpoint, moveTicket } from "./ticket-lifecycle.js";

async function ticketFile(body: string, name = "fix-login.md"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-lifecycle-"));
  const path = join(dir, name);
  await writeFile(path, body);
  return path;
}

test("attempt section appends after ticket content without altering it", async () => {
  const path = await ticketFile("---\nname: fix-login\n---\n# Fix login\nBody.");
  await annotateAttempt(path, {
    timestamp: "2026-10-11T07:00:00.000Z",
    attemptId: "1a2b3c",
    workspacePath: "/factory/.workspaces/fix-login-1a2b3c",
    branch: "agent-tickets/fix-login-1a2b3c",
    repository: "git@github.com:acme/app.git",
    baseBranch: "main",
  });
  const final = await readFile(path, "utf8");
  assert.ok(final.startsWith("---\nname: fix-login\n---\n# Fix login\nBody."));
  assert.match(final, /## Attempt 1a2b3c \(2026-10-11T07:00:00\.000Z\)/);
  assert.match(final, /- Workspace: `\/factory\/\.workspaces\/fix-login-1a2b3c`/);
  assert.match(final, /- Branch: `agent-tickets\/fix-login-1a2b3c`/);
  assert.match(final, /- Repository: `git@github\.com:acme\/app\.git`/);
  assert.match(final, /- Base branch: `main`/);
});

test("completion section records workspace, branch, base branch, final SHA, and draft PR URL", async () => {
  const path = await ticketFile("# Fix login\nBody.");
  await annotateCompletion(path, {
    timestamp: "2026-10-11T08:00:00.000Z",
    attemptId: "1a2b3c",
    workspacePath: "/factory/.workspaces/fix-login-1a2b3c",
    branch: "agent-tickets/fix-login-1a2b3c",
    baseBranch: "release/2.1",
    finalSha: "9f3ab12c5d6e7f8091a2b3c4d5e6f70819203040",
    pullRequestUrl: "https://github.com/acme/app/pull/7",
    squashPreference: "configured",
  });
  const final = await readFile(path, "utf8");
  assert.match(final, /## Completed 1a2b3c \(2026-10-11T08:00:00\.000Z\)/);
  assert.match(final, /- Base branch: `release\/2\.1`/);
  assert.match(final, /- Final commit: `9f3ab12c5d6e7f8091a2b3c4d5e6f70819203040`/);
  assert.match(final, /- Draft PR: https:\/\/github\.com\/acme\/app\/pull\/7/);
});

test("completion section records the persisted merge method", async () => {
  const path = await ticketFile("# Fix login\nBody.");

  await annotateCompletion(path, {
    timestamp: "2026-10-11T08:00:00.000Z",
    attemptId: "1a2b3c",
    workspacePath: "/factory/.workspaces/fix-login-1a2b3c",
    branch: "agent-tickets/fix-login-1a2b3c",
    baseBranch: "main",
    finalSha: "9".repeat(40),
    pullRequestUrl: "https://github.com/acme/app/pull/7",
    squashPreference: "unsupported",
  });

  const final = await readFile(path, "utf8");
  assert.match(final, /- Merge method: squash \(unsupported\)/);
});

test("failure section records stage, sanitized command, exit status, and fenced output", async () => {
  const path = await ticketFile("# Fix login\nBody.");
  await annotateFailure(path, {
    timestamp: "2026-10-11T09:00:00.000Z",
    attemptId: "1a2b3c",
    stage: "push",
    command: "git push --set-upstream origin agent-tickets/fix-login-1a2b3c",
    exitCode: 128,
    stdout: "remote: rejected\ntoken gh_secret_abc",
    stderr: "git@github.com: Permission denied (publickey). gh_secret_abc",
    secret: "gh_secret_abc",
  });
  const final = await readFile(path, "utf8");
  assert.match(final, /## Failed at stage `push` \(2026-10-11T09:00:00\.000Z\)/);
  assert.match(final, /exit code \/ HTTP status: 128/);
  assert.match(final, /- stdout:\n```text\nremote: rejected\ntoken \[redacted-token\]\n```/);
  assert.match(final, /- stderr:\n```text\ngit@github\.com: Permission denied \(publickey\)\. \[redacted-token\]\n```/);
  assert.ok(!final.includes("gh_secret_abc"), "the literal token never reaches the ticket file");
});

test("the provider credential is redacted from Azure DevOps failure annotations", async () => {
  const path = await ticketFile("# Fix login\nBody.");
  await annotateFailure(path, {
    timestamp: "2026-10-11T09:00:00.000Z",
    attemptId: "1a2b3c",
    stage: "draft pull request",
    command: "POST https://dev.azure.com/contoso/web/_apis/git/repositories/fix-login/pullrequests?api-version=7.1",
    exitCode: 401,
    stdout: "TF400813: Authorization failed for vso_pat_secret_123",
    stderr: "HTTP 401 Unauthorized",
    secret: "vso_pat_secret_123",
  });
  const final = await readFile(path, "utf8");
  assert.match(final, /## Failed at stage `draft pull request`/);
  assert.match(final, /exit code \/ HTTP status: 401/);
  assert.ok(!final.includes("vso_pat_secret_123"), "the literal PAT never reaches the ticket file");
});

test("command output containing fences is preserved verbatim inside a longer fence", async () => {
  const path = await ticketFile("# Fix login\nBody.");
  const hostile = "```text\nfake section\n```";
  await annotateFailure(path, {
    timestamp: "2026-10-11T09:00:00.000Z",
    attemptId: "1a2b3c",
    stage: "implement",
    command: "dotnet test",
    exitCode: 1,
    stdout: hostile,
    stderr: "",
    secret: "gh_secret_abc",
  });
  const final = await readFile(path, "utf8");
  assert.match(final, /- stdout:\n````text\n```text\nfake section\n```\n````/);
});

test("moveTicket creates the lifecycle directory lazily and preserves the filename", async () => {
  const path = await ticketFile("# Fix login\nBody.", "fix-login.md");
  const destination = await moveTicket(path, join(dirname(path), "done"), "1a2b3c");
  assert.equal(destination.split("/").pop(), "fix-login.md");
  assert.equal(await readFile(destination, "utf8"), "# Fix login\nBody.");
});

test("destination collision appends the attempt ID instead of overwriting trace evidence", async () => {
  const path = await ticketFile("# Fix login\nBody.", "fix-login.md");
  const doneDir = join(dirname(path), "done");
  await mkdir(doneDir, { recursive: true });
  await writeFile(join(doneDir, "fix-login.md"), "# Existing\n");
  const destination = await moveTicket(path, doneDir, "1a2b3c");
  assert.equal(destination.split("/").pop(), "fix-login-1a2b3c.md");
  assert.equal(await readFile(join(doneDir, "fix-login.md"), "utf8"), "# Existing\n");
  assert.equal(await readFile(destination, "utf8"), "# Fix login\nBody.");
});

test("collision on the attempt-suffixed destination refuses to overwrite", async () => {
  const path = await ticketFile("# Fix login\nBody.", "fix-login.md");
  const doneDir = join(dirname(path), "done");
  await mkdir(doneDir, { recursive: true });
  await writeFile(join(doneDir, "fix-login.md"), "# Existing\n");
  await writeFile(join(doneDir, "fix-login-1a2b3c.md"), "# Existing attempt\n");
  await assert.rejects(moveTicket(path, doneDir, "1a2b3c"), /already exists/);
  assert.equal(await readFile(join(doneDir, "fix-login-1a2b3c.md"), "utf8"), "# Existing attempt\n");
});

test("stage checkpoint section records attempt, stage, commits, changes, and the invocation-relative transcript path", async () => {
  const path = await ticketFile("# Fix login\nBody.");

  await annotateStageCheckpoint(path, {
    timestamp: "2026-10-11T07:30:00.000Z",
    attemptId: "1a2b3c",
    stage: "implement",
    parentSha: "1111111111111111111111111111111111111111",
    checkpointSha: "2222222222222222222222222222222222222222",
    changes: "changed",
    agentLogReference: "2026-10-11_07-29-58-1a2b3c/implement-1.log",
  });

  const final = await readFile(path, "utf8");
  assert.ok(final.startsWith("# Fix login\nBody."));
  assert.match(final, /## Stage checkpoint implement \(2026-10-11T07:30:00\.000Z\)/);
  assert.match(final, /- Attempt ID: `1a2b3c`/);
  assert.match(final, /- Stage: `implement`/);
  assert.match(final, /- Parent commit: `1{40}`/);
  assert.match(final, /- Checkpoint commit: `2{40}`/);
  assert.match(final, /- Changes: changed/);
  assert.match(final, /- Agent log: `2026-10-11_07-29-58-1a2b3c\/implement-1\.log`/);
});

test("stage checkpoint annotations append in order without rewriting earlier sections", async () => {
  const path = await ticketFile("# Fix login\nBody.");

  await annotateStageCheckpoint(path, { timestamp: "2026-10-11T07:30:00.000Z", attemptId: "1a2b3c", stage: "implement", parentSha: "1".repeat(40), checkpointSha: "2".repeat(40), changes: "changed", agentLogReference: "2026-10-11_07-29-58-1a2b3c/implement-1.log" });
  await annotateStageCheckpoint(path, { timestamp: "2026-10-11T07:40:00.000Z", attemptId: "1a2b3c", stage: "review", parentSha: "2".repeat(40), checkpointSha: "3".repeat(40), changes: "unchanged", agentLogReference: "2026-10-11_07-29-58-1a2b3c/review-1.log" });

  const final = await readFile(path, "utf8");
  const implementAt = final.indexOf("## Stage checkpoint implement");
  const reviewAt = final.indexOf("## Stage checkpoint review");
  assert.ok(implementAt > 0 && reviewAt > implementAt);
  assert.match(final, /- Changes: unchanged/);
  assert.match(final, /- Agent log: `2026-10-11_07-29-58-1a2b3c\/implement-1\.log`/);
  assert.match(final, /- Agent log: `2026-10-11_07-29-58-1a2b3c\/review-1\.log`/);
});
