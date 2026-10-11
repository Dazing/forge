import { requireCleanRepository, requireNoUnmergedEntries, runGit, snapshotHeadAndBranch } from "../../infrastructure/git-provider/git.js";

// Runner-owned checkpoint commit for one successful mutating stage. The agent reports prose; the
// runner stages the work, computes the tree-change flag from Git itself, appends the runner-owned
// trailers, and verifies the resulting commit. Failures preserve the workspace, index, and commits:
// nothing is reset, retried, or cleaned.

/** Mutating stages that produce exactly one runner-owned checkpoint commit. */
export type StageName = "implement" | "review";

/** Commit trailers the runner appends to every checkpoint message. */
const trailerKeys = ["Factory-Ticket", "Factory-Attempt", "Factory-Stage", "Factory-Outcome", "Factory-Changes", "Factory-Agent-Log"] as const;

export interface StageCommitInput {
  workspacePath: string;
  branch: string;
  ticketId: string;
  attemptId: string;
  stage: StageName;
  /** Validated stage message from the agent. */
  message: string;
  /** HEAD captured at the stage entry; the checkpoint must start from exactly this commit. */
  expectedHead: string;
  agentLogBasename: string;
  /** Credential values, including derived forms, that must never reach a Git message. */
  forbiddenSecrets: readonly string[];
}

/** Verified checkpoint commit identity. */
export interface StageCommitResult {
  parentSha: string;
  checkpointSha: string;
  changes: "changed" | "unchanged";
}

/** Build the checkpoint message from validated prose plus runner-owned trailers. */
function checkpointMessage(input: StageCommitInput, changes: "changed" | "unchanged"): string {
  const trailers = [
    `Factory-Ticket: ${input.ticketId}`,
    `Factory-Attempt: ${input.attemptId}`,
    `Factory-Stage: ${input.stage}`,
    `Factory-Outcome: complete`,
    `Factory-Changes: ${changes}`,
    `Factory-Agent-Log: ${input.agentLogBasename}`,
  ];
  return `${input.message}\n\n${trailers.join("\n")}`;
}

/**
 * Create the single checkpoint commit for a successful stage: recheck the expected branch and
 * captured HEAD, reject unresolved merge entries, stage all work, compute the tree-change flag
 * from the staged tree, reject credential material in the message, commit, then require exactly
 * one new single-parent commit whose parent is the captured HEAD on the expected branch with a
 * completely clean index and worktree.
 */
export async function commitStage(input: StageCommitInput): Promise<StageCommitResult> {
  const entry = await snapshotHeadAndBranch(input.workspacePath);
  if (entry.branch !== input.branch) {
    throw new Error(`checkpoint requires the workspace on branch ${input.branch}, found ${entry.branch}.`);
  }
  if (entry.head !== input.expectedHead) {
    throw new Error(`checkpoint found the workspace HEAD moved from ${input.expectedHead} to ${entry.head}.`);
  }
  await requireNoUnmergedEntries(input.workspacePath, "Stage checkpoint");

  await runGit(input.workspacePath, ["add", "--all"], "staging stage work");
  const parentTree = (await runGit(input.workspacePath, ["rev-parse", `${input.expectedHead}^{tree}`], "reading stage parent tree")).trim();
  const stagedTree = (await runGit(input.workspacePath, ["write-tree"], "reading staged tree")).trim();
  const changes: "changed" | "unchanged" = stagedTree === parentTree ? "unchanged" : "changed";

  const message = checkpointMessage(input, changes);
  const secret = input.forbiddenSecrets.find((value) => message.includes(value));
  if (secret !== undefined) {
    throw new Error(`checkpoint message contains provider credential material for ticket ${input.ticketId} on stage ${input.stage}.`);
  }

  await runGit(input.workspacePath, ["commit", "--allow-empty", "-m", message], "creating stage checkpoint commit");

  const after = await snapshotHeadAndBranch(input.workspacePath);
  if (after.branch !== input.branch) {
    throw new Error(`stage checkpoint commit switched the workspace branch to ${after.branch}.`);
  }
  const parents = (await runGit(input.workspacePath, ["rev-list", "--parents", "-n", "1", "HEAD"], "reading the checkpoint commit parents")).trim().split(" ");
  const checkpointSha = parents[0]!;
  const parentShas = parents.slice(1);
  if (parentShas.length !== 1 || parentShas[0] !== input.expectedHead) {
    throw new Error(`stage checkpoint commit ${checkpointSha} has parents ${parentShas.join(", ")}, expected exactly one parent ${input.expectedHead}.`);
  }
  const ahead = (await runGit(input.workspacePath, ["rev-list", "--count", `${input.expectedHead}..HEAD`], "counting commits ahead of the stage entry")).trim();
  if (ahead !== "1") {
    throw new Error(`stage checkpoint produced ${ahead} commits ahead of ${input.expectedHead}, expected exactly one.`);
  }
  const checkpointTree = (await runGit(input.workspacePath, ["rev-parse", `${checkpointSha}^{tree}`], "reading checkpoint tree")).trim();
  const actualChanges = checkpointTree === parentTree ? "unchanged" : "changed";
  if (actualChanges !== changes) {
    throw new Error(`stage checkpoint tree changes disagree with recorded metadata: recorded ${changes}, actual ${actualChanges}; retained commit ${checkpointSha}.`);
  }
  await requireCleanRepository(input.workspacePath, `Stage checkpoint for ticket ${input.ticketId}`);

  return { parentSha: entry.head, checkpointSha, changes };
}
