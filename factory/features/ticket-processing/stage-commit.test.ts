import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../../infrastructure/git-provider/git.js";
import { commitStage, type StageCommitInput } from "./stage-commit.js";

const BRANCH = "agent-tickets/fix-login-1a2b3c";
const SECRET = "ghp_supersecrettoken";

// The checkpoint commit uses the ambient Git identity; the runner never injects a fake one.
process.env.GIT_AUTHOR_NAME = "Checkpoint Test";
process.env.GIT_AUTHOR_EMAIL = "checkpoint@test.example";
process.env.GIT_COMMITTER_NAME = "Checkpoint Test";
process.env.GIT_COMMITTER_EMAIL = "checkpoint@test.example";

function git(cwd: string, args: string[], operation?: string): Promise<string> {
  return runCommand("git", ["-C", cwd, "-c", "user.email=runner@test", "-c", "user.name=Runner", ...args], operation ?? `running git ${args[0]}`);
}

/** Real workspace on the ticket branch with one committed base file. */
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sandcastle-checkpoint-"));
  await runCommand("git", ["init", "-b", "main", path], "initializing workspace");
  await writeFile(join(path, "README.md"), "# App\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "init"]);
  await git(path, ["switch", "-c", BRANCH]);
  return path;
}

function input(workspacePath: string, expectedHead: string, overrides: Partial<StageCommitInput> = {}): StageCommitInput {
  return {
    workspacePath,
    branch: BRANCH,
    ticketId: "0123456789abcdef",
    attemptId: "1a2b3c",
    stage: "implement",
    message: "fix(login): redirect after auth\n\nRan npm test; 12 passed.",
    expectedHead,
    agentLogBasename: "implement-0123456789abcdef-1a2b3c.log",
    forbiddenSecrets: [SECRET],
    ...overrides,
  };
}

test("checkpoint commits stage work with runner trailers and reports changed", async () => {
  const path = await workspace();
  const entryHead = (await git(path, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();
  await writeFile(join(path, "login.ts"), "export const redirect = true;\n");

  const result = await commitStage(input(path, entryHead));

  assert.equal(result.changes, "changed");
  assert.equal(result.parentSha, entryHead);
  const message = (await git(path, ["log", "-1", "--format=%B", result.checkpointSha], "reading commit message")).trim();
  assert.equal(message, [
    "fix(login): redirect after auth",
    "",
    "Ran npm test; 12 passed.",
    "",
    "Factory-Ticket: 0123456789abcdef",
    "Factory-Attempt: 1a2b3c",
    "Factory-Stage: implement",
    "Factory-Outcome: complete",
    "Factory-Changes: changed",
    "Factory-Agent-Log: implement-0123456789abcdef-1a2b3c.log",
  ].join("\n"));
  assert.equal((await git(path, ["rev-list", "--count", `${entryHead}..HEAD`], "counting commits ahead")).trim(), "1");
  assert.equal((await git(path, ["rev-parse", `${result.checkpointSha}^`], "reading the commit parent")).trim(), entryHead);
  assert.equal((await git(path, ["rev-parse", "--abbrev-ref", "HEAD"], "reading HEAD branch")).trim(), BRANCH);
  assert.equal((await git(path, ["status", "--porcelain"], "reading worktree status")).trim(), "");
});

test("checkpoint records an unchanged empty commit when the stage changed no files", async () => {
  const path = await workspace();
  const entryHead = (await git(path, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();

  const result = await commitStage(input(path, entryHead, { stage: "review", message: "chore(review): no changes required\n\nAll checks passed." }));

  assert.equal(result.changes, "unchanged");
  assert.equal(result.parentSha, entryHead);
  const message = (await git(path, ["log", "-1", "--format=%B", result.checkpointSha], "reading commit message")).trim();
  assert.match(message, /^chore\(review\): no changes required/);
  assert.match(message, /Factory-Changes: unchanged/);
  assert.match(message, /Factory-Stage: review/);
  assert.equal((await git(path, ["rev-list", "--count", `${entryHead}..HEAD`], "counting commits ahead")).trim(), "1");
  assert.equal((await git(path, ["status", "--porcelain"], "reading worktree status")).trim(), "");
});

test("checkpoint rejects credential material before writing the message to Git", async () => {
  const path = await workspace();
  const entryHead = (await git(path, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();
  await writeFile(join(path, "login.ts"), "export const redirect = true;\n");

  await assert.rejects(
    commitStage(input(path, entryHead, { message: `fix(login): redirect using token ${SECRET}` })),
    /checkpoint message contains provider credential material/,
  );
  assert.equal((await git(path, ["rev-parse", "HEAD"], "reading HEAD commit")).trim(), entryHead);
  assert.equal((await git(path, ["rev-list", "--count", `${entryHead}..HEAD`], "counting commits ahead")).trim(), "0");
});

test("checkpoint refuses to commit on the wrong branch and preserves the workspace", async () => {
  const path = await workspace();
  const entryHead = (await git(path, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();
  await git(path, ["switch", "-c", "agent-tickets/other"]);
  await writeFile(join(path, "login.ts"), "export const redirect = true;\n");

  await assert.rejects(commitStage(input(path, entryHead)), /checkpoint requires the workspace on branch .* found agent-tickets\/other/);
  assert.equal((await git(path, ["rev-parse", "HEAD"], "reading HEAD commit")).trim(), entryHead);
  assert.equal((await git(path, ["rev-parse", "--abbrev-ref", "HEAD"], "reading HEAD branch")).trim(), "agent-tickets/other");
  assert.match((await git(path, ["status", "--porcelain"], "reading worktree status")).trim(), /\?\? login\.ts/);
});

test("checkpoint refuses to commit while merge conflicts are unresolved", async () => {
  const path = await workspace();
  await writeFile(join(path, "conflict.txt"), "base\n");
  await git(path, ["add", "conflict.txt"]);
  await git(path, ["commit", "-m", "base conflict file"]);
  await git(path, ["switch", "-c", "side"]);
  await writeFile(join(path, "conflict.txt"), "side\n");
  await git(path, ["add", "conflict.txt"]);
  await git(path, ["commit", "-m", "side change"]);
  await git(path, ["switch", BRANCH]);
  await writeFile(join(path, "conflict.txt"), "ours\n");
  await git(path, ["add", "conflict.txt"]);
  await git(path, ["commit", "-m", "our change"]);
  const entryHead = (await git(path, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();
  await assert.rejects(git(path, ["merge", "side"]));

  await assert.rejects(commitStage(input(path, entryHead)), /unresolved merge conflicts/);
  assert.equal((await git(path, ["rev-list", "--count", `${entryHead}..HEAD`], "counting commits ahead")).trim(), "0");
});

test("checkpoint rejects a commit the agent created during the stage and retains both commits", async () => {
  const path = await workspace();
  const entryHead = (await git(path, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();
  await writeFile(join(path, "login.ts"), "export const redirect = true;\n");
  await git(path, ["add", "login.ts"]);
  await git(path, ["commit", "-m", "fix login redirect"]);

  await assert.rejects(commitStage(input(path, entryHead)), /checkpoint found the workspace HEAD moved from .* to .*/);
  assert.equal((await git(path, ["rev-list", "--count", `${entryHead}..HEAD`], "counting commits ahead")).trim(), "1");
});

test("checkpoint fails when the commit leaves new untracked output and retains the commit", async () => {
  const path = await workspace();
  const entryHead = (await git(path, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();
  await writeFile(join(path, "login.ts"), "export const redirect = true;\n");
  const hook = join(path, ".git", "hooks", "post-commit");
  await writeFile(hook, "#!/bin/sh\ntouch generated.txt\n");
  await chmod(hook, 0o755);

  await assert.rejects(commitStage(input(path, entryHead)), /left uncommitted changes in the branch worktree: \?\? generated\.txt/);
  assert.equal((await git(path, ["rev-list", "--count", `${entryHead}..HEAD`], "counting commits ahead")).trim(), "1");
});

test("checkpoint rejects hook-generated tree changes that contradict unchanged metadata and retains the commit", async (t) => {
  const path = await workspace();
  t.after(() => rm(path, { recursive: true, force: true }));
  const entryHead = (await git(path, ["rev-parse", "HEAD"])).trim();
  const hook = join(path, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nprintf generated > generated.txt\ngit add generated.txt\n");
  await chmod(hook, 0o755);

  await assert.rejects(
    commitStage(input(path, entryHead, { stage: "review", message: "chore(review): no changes needed" })),
    /checkpoint tree changes.*unchanged.*changed/,
  );

  assert.equal((await git(path, ["rev-list", "--count", `${entryHead}..HEAD`])).trim(), "1");
  assert.equal((await git(path, ["diff", "--name-only", entryHead, "HEAD"])).trim(), "generated.txt");
  assert.equal((await git(path, ["status", "--porcelain"])).trim(), "");
});
