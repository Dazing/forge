import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentBranch, requireCleanRepository, runCommand, runGit, snapshotRepository } from "./git.js";

const commitArgs = ["-c", "user.email=test@example.com", "-c", "user.name=Sandcastle Test"];

async function repository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sandcastle-clean-repository-"));
  await runCommand("git", ["init", "-b", "main", path], "initializing test repository");
  await writeFile(join(path, "tracked.txt"), "initial\n");
  await runGit(path, ["add", "tracked.txt"], "staging initial file");
  await runGit(path, [...commitArgs, "commit", "-m", "initial"], "creating initial commit");
  return path;
}

test("clean repository passes stage cleanliness enforcement", async () => {
  const path = await repository();
  await requireCleanRepository(path, "Review for ticket abc");
});

test("tracked and untracked changes fail stage cleanliness enforcement", async () => {
  const path = await repository();
  await writeFile(join(path, "tracked.txt"), "changed\n");
  await writeFile(join(path, "untracked.txt"), "new\n");

  await assert.rejects(
    requireCleanRepository(path, "Review for ticket abc"),
    /Review for ticket abc left uncommitted changes in the branch worktree: M tracked\.txt, \?\? untracked\.txt/,
  );
});

test("currentBranch reports the symbolic branch, not a detached commit", async () => {
  const path = await repository();
  assert.equal(await currentBranch(path), "main");
  await runGit(path, ["switch", "-c", "feature/login"], "switching to a feature branch");
  assert.equal(await currentBranch(path), "feature/login");
  const head = (await runGit(path, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();
  await runGit(path, ["checkout", head], "detaching HEAD");
  assert.equal(await currentBranch(path), "HEAD");
});
