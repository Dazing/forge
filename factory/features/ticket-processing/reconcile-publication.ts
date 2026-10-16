import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit, runGitAsRunner } from "../../infrastructure/git-provider/git.js";

export interface PublishedDelta {
  readonly workspacePath: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly publishedSha: string;
}

/** Clone the published target repository at its base branch so a merge result can be verified after a restart, when no attempt workspace remains. */
export async function cloneTargetRepository(repository: string, baseBranch: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-publication-verify-"));
  const workspacePath = join(root, "repository");
  await runGitAsRunner(root, ["clone", "--single-branch", "--branch", baseBranch, repository, workspacePath], `cloning ${repository} to verify merged work`);
  return workspacePath;
}

/** Verify a provider-reported merge result by applying the exact published delta to its first parent and comparing trees. */
export async function verifyMergedPublication(delta: PublishedDelta, mergeResultSha: string): Promise<string> {
  await runGit(delta.workspacePath, ["fetch", "origin", delta.baseBranch], "refreshing publication base");
  await runGit(delta.workspacePath, ["cat-file", "-e", `${mergeResultSha}^{commit}`], "validating merge-result commit");
  await runGit(delta.workspacePath, ["merge-base", "--is-ancestor", mergeResultSha, `origin/${delta.baseBranch}`], "checking merge result on refreshed base");
  const changed = (await runGit(delta.workspacePath, ["diff", "--name-only", delta.baseSha, delta.publishedSha], "checking published delta")).trim();
  if (changed.length === 0) throw new Error("Empty checkpoint history is not merged-work equivalence evidence.");
  const firstParent = (await runGit(delta.workspacePath, ["rev-parse", `${mergeResultSha}^1`], "reading merge-result first parent")).trim();
  const expectedTree = (await runGit(delta.workspacePath, ["rev-parse", `${mergeResultSha}^{tree}`], "reading merge-result tree")).trim();
  const patch = await runGit(delta.workspacePath, ["diff", "--binary", delta.baseSha, delta.publishedSha], "reading published delta");
  const verificationRoot = await mkdtemp(join(tmpdir(), "sandcastle-merge-verify-"));
  const worktree = join(verificationRoot, "worktree");
  const patchPath = join(verificationRoot, "published.patch");
  await writeFile(patchPath, patch);
  try {
    await runGit(delta.workspacePath, ["worktree", "add", "--detach", worktree, firstParent], "creating merge verification worktree");
    await runGit(worktree, ["apply", "--index", patchPath], "applying published delta for merge verification");
    const actualTree = (await runGit(worktree, ["write-tree"], "reading applied delta tree")).trim();
    if (actualTree !== expectedTree) throw new Error(`Merged tree ${expectedTree} does not match published delta tree ${actualTree}.`);
  } finally {
    await runGit(delta.workspacePath, ["worktree", "remove", "--force", worktree], "removing merge verification worktree").catch(() => undefined);
    await rm(verificationRoot, { recursive: true, force: true });
  }
  return (await runGit(delta.workspacePath, ["rev-parse", `origin/${delta.baseBranch}`], "reading refreshed base SHA")).trim();
}
