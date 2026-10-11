import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCommand, runGit } from "../../infrastructure/git-provider/git.js";
import { verifyMergedPublication } from "./reconcile-publication.js";

process.env.GIT_AUTHOR_NAME = "Reconciliation Test";
process.env.GIT_AUTHOR_EMAIL = "reconciliation@test.example";
process.env.GIT_COMMITTER_NAME = "Reconciliation Test";
process.env.GIT_COMMITTER_EMAIL = "reconciliation@test.example";

async function squashFixture(mergedContent: string) {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-reconcile-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const workspace = join(root, "workspace");
  await runCommand("git", ["init", "--bare", remote], "initializing reconciliation remote");
  await runCommand("git", ["init", "-b", "main", seed], "initializing reconciliation seed");
  await writeFile(join(seed, "README.md"), "base\n");
  await runGit(seed, ["add", "README.md"], "staging reconciliation base");
  await runGit(seed, ["commit", "-m", "base"], "committing reconciliation base");
  await runGit(seed, ["remote", "add", "origin", remote], "adding reconciliation remote");
  await runGit(seed, ["push", "-u", "origin", "main"], "pushing reconciliation base");
  const baseSha = (await runGit(seed, ["rev-parse", "HEAD"], "reading reconciliation base")).trim();

  await runCommand("git", ["clone", "--branch", "main", remote, workspace], "cloning reconciliation workspace");
  await runGit(workspace, ["switch", "-c", "published"], "creating published branch");
  await writeFile(join(workspace, "delivery.txt"), "reviewed\n");
  await runGit(workspace, ["add", "delivery.txt"], "staging published delta");
  await runGit(workspace, ["commit", "-m", "published"], "committing published delta");
  const publishedSha = (await runGit(workspace, ["rev-parse", "HEAD"], "reading published SHA")).trim();

  await writeFile(join(seed, "delivery.txt"), mergedContent);
  await runGit(seed, ["add", "delivery.txt"], "staging squash result");
  await runGit(seed, ["commit", "-m", "squash result"], "committing squash result");
  await runGit(seed, ["push", "origin", "main"], "pushing squash result");
  const mergeResultSha = (await runGit(seed, ["rev-parse", "HEAD"], "reading merge-result SHA")).trim();
  return { workspace, baseSha, publishedSha, mergeResultSha };
}

test("verified squash-equivalent work satisfies the refreshed base", async () => {
  const fixture = await squashFixture("reviewed\n");
  const refreshed = await verifyMergedPublication({
    workspacePath: fixture.workspace,
    baseBranch: "main",
    baseSha: fixture.baseSha,
    publishedSha: fixture.publishedSha,
  }, fixture.mergeResultSha);
  assert.equal(refreshed, fixture.mergeResultSha);
});

test("mismatched squash trees are rejected instead of replaying retained work", async () => {
  const fixture = await squashFixture("different\n");
  await assert.rejects(
    verifyMergedPublication({
      workspacePath: fixture.workspace,
      baseBranch: "main",
      baseSha: fixture.baseSha,
      publishedSha: fixture.publishedSha,
    }, fixture.mergeResultSha),
    /does not match published delta tree/,
  );
});
