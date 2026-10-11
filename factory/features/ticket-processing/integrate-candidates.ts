import { resolve } from "node:path";
import { CommandFailedError, currentBranch, requireCleanRepository, requireNoUnmergedEntries, runGit, runGitAsRunner } from "../../infrastructure/git-provider/git.js";
import { integrateTickets } from "../integrate-tickets/index.js";
import type { ProcessConfig } from "./process-config.js";
import { createWorkspace, reserveAttempt, type WorkspaceBaseline } from "./workspace.js";
import type { ReviewedCheckpoint } from "./execute-attempt.js";

export type ReviewedCandidate = Readonly<{
  groupId: string;
  includedTicketIds: readonly string[];
  workspacePath: string;
  branch: string;
  sha: string;
  conflicts: readonly Readonly<{ path: string; disposition: string }>[];
}>;

export async function integrateCandidates(
  groupId: string,
  candidates: readonly ReviewedCheckpoint[],
  config: ProcessConfig,
  baseline?: WorkspaceBaseline,
): Promise<ReviewedCandidate> {
  if (candidates.length === 0) throw new Error(`Cannot integrate empty group ${groupId}.`);
  const ordered = [...candidates].sort((left, right) => left.ticket.id.localeCompare(right.ticket.id));
  if (ordered.length === 1 && baseline === undefined) {
    const only = ordered[0]!;
    return { groupId, includedTicketIds: [only.ticket.id], workspacePath: only.workspacePath, branch: only.branch, sha: only.reviewCheckpoint.checkpointSha, conflicts: [] };
  }

  const first = ordered[0]!;
  const reserved = await reserveAttempt(resolve(config.factoryRoot, ".workspaces"), `integrate-${groupId}`);
  const workspace = await createWorkspace(first.ticket, reserved, baseline ?? { sha: first.reviewCheckpoint.checkpointSha, repositoryPath: first.workspacePath });
  const conflicts: Array<Readonly<{ path: string; disposition: string }>> = [];
  const included = baseline === undefined ? [first.ticket.id] : [];
  const pending = baseline === undefined ? ordered.slice(1) : ordered;

  for (const candidate of pending) {
    await runGit(workspace.workspacePath, ["fetch", "--no-tags", candidate.workspacePath, candidate.reviewCheckpoint.checkpointSha], `importing reviewed checkpoint ${candidate.ticket.id}`);
    const parent = (await runGit(workspace.workspacePath, ["rev-parse", "HEAD"], "reading integration parent")).trim();
    let conflictPaths: string[] = [];
    try {
      await runGit(workspace.workspacePath, ["merge", "--no-ff", "--no-commit", candidate.reviewCheckpoint.checkpointSha], `merging reviewed checkpoint ${candidate.ticket.id}`);
    } catch (error) {
      if (!(error instanceof CommandFailedError) || error.failure.exitCode !== 1) throw error;
      conflictPaths = (await runGit(workspace.workspacePath, ["diff", "--name-only", "--diff-filter=U"], "listing integration conflicts"))
        .split("\n").filter(Boolean).sort();
      if (conflictPaths.length === 0) throw error;
    }

    const integrationLogName = `integrate-${groupId}-${workspace.attemptId}`;
    const outcome = await integrateTickets({
      groupId: `${groupId}-${workspace.attemptId}`,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      includedTickets: [...included.map((id) => {
        const prior = ordered.find((item) => item.ticket.id === id)!;
        return { id, title: prior.ticket.title, checkpointSha: prior.reviewCheckpoint.checkpointSha, summary: "reviewed ticket checkpoint" };
      }), { id: candidate.ticket.id, title: candidate.ticket.title, checkpointSha: candidate.reviewCheckpoint.checkpointSha, summary: "reviewed ticket checkpoint" }],
      conflictPaths,
      task: conflictPaths.length > 0 ? "resolve-and-review" : "combined-review",
      harness: config.harness,
      runAgent: config.runAgent,
    });
    await requireNoUnmergedEntries(workspace.workspacePath, "integration finalization");
    if (await currentBranch(workspace.workspacePath) !== workspace.branch) throw new Error(`Integration finalization changed branch ${workspace.branch}.`);
    if ((await runGit(workspace.workspacePath, ["rev-parse", "HEAD"], "checking integration parent")).trim() !== parent) throw new Error("Integration agent changed HEAD before finalization.");
    if (config.gitProvider.secrets().some((secret) => secret.length > 0 && outcome.message.includes(secret))) throw new Error("Integration message contains provider credential material.");
    await runGit(workspace.workspacePath, ["add", "--all"], "staging integration result");
    const changes = (await runGit(workspace.workspacePath, ["diff", "--cached", "--name-only"], "classifying integration tree outcome")).trim().length > 0 ? "changed" : "unchanged";
    const agentLogBasename = config.logger.agentLogBasename(integrationLogName);
    await runGitAsRunner(workspace.workspacePath, ["commit", "-m", `${outcome.message}\n\nFactory-Group: ${groupId}\nFactory-Stage: integration\nFactory-Included: ${[...included, candidate.ticket.id].join(",")}\nFactory-Changes: ${changes}\nFactory-Agent-Log: ${agentLogBasename}`], "committing reviewed integration");
    const checkpointSha = (await runGit(workspace.workspacePath, ["rev-parse", "HEAD"], "reading integration checkpoint")).trim();
    const actualParents = (await runGit(workspace.workspacePath, ["show", "-s", "--format=%P", "HEAD"], "validating integration parents")).trim().split(/\s+/);
    if (actualParents.length !== 2 || actualParents[0] !== parent || actualParents[1] !== candidate.reviewCheckpoint.checkpointSha) {
      throw new Error(`Integration commit parents ${actualParents.join(", ")} do not match ${parent}, ${candidate.reviewCheckpoint.checkpointSha}.`);
    }
    const actualChanges = (await runGit(workspace.workspacePath, ["diff", "--name-only", parent, checkpointSha], "validating integration tree outcome")).trim().length > 0 ? "changed" : "unchanged";
    if (actualChanges !== changes) throw new Error(`Integration checkpoint recorded ${changes} but committed tree is ${actualChanges}.`);
    await config.logger.record({
      timestamp: new Date().toISOString(),
      attemptId: workspace.attemptId,
      stage: "integration commit",
      operation: groupId,
      status: "success",
      parentSha: parent,
      checkpointSha,
      changes,
      agentLogBasename,
    });
    await requireCleanRepository(workspace.workspacePath, "integration finalization");
    included.push(candidate.ticket.id);
    conflicts.push(...outcome.conflicts);
  }

  return {
    groupId,
    includedTicketIds: included,
    workspacePath: workspace.workspacePath,
    branch: workspace.branch,
    sha: (await runGit(workspace.workspacePath, ["rev-parse", "HEAD"], "reading reviewed integration SHA")).trim(),
    conflicts,
  };
}
