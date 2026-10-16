import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Ticket } from "../tickets/index.js";
import { implementTicket } from "../implement-ticket/index.js";
import { reviewTicket } from "../review-ticket/index.js";
import { toCommandFailure, type CommandFailure } from "../../infrastructure/git-provider/git.js";
import { commitStage, type StageCommitResult, type StageName } from "./stage-commit.js";
import { createWorkspace, reserveAttempt, type WorkspaceBaseline } from "./workspace.js";
import { logSettlementFailure } from "./settle-attempt.js";
import { detectAuthorizationLapse, preserveAttemptWorkspace, type PreservedAttempt } from "./authorization-lapse.js";
import { isAuthorizationWithdrawn, type StageAuthorization } from "./authorization-guard.js";
import type { ProcessConfig } from "./process-config.js";

// One fresh complete ticket attempt: reserve, claim the backlog issue, create a dependency-based
// workspace, then implement and review with runner-owned checkpoint/trace boundaries. Publication is
// group-owned. Failed workspaces remain retained; only reviewed checkpoints enter workflow state.

interface Attempt {
  readonly workspacePath: string;
  readonly branch: string;
  readonly attemptId: string;
}

/** Failure-stage labels for the two mutating boundaries. */
const commitStages = { implement: "implementation commit", review: "review commit" } as const;

/** One stage's validated message plus the HEAD its work started from. */
type StageOutcome = Readonly<{ message: string; head: string; logReference: string }>;
export type ReviewedCheckpoint = Readonly<{
  ticket: Ticket;
  attemptId: string;
  workspacePath: string;
  branch: string;
  implementationCheckpoint: StageCommitResult;
  reviewCheckpoint: StageCommitResult;
  baselineSha: string;
  requirementsHash: string;
}>;

export type ReviewedAttemptResult =
  | Readonly<{ status: "reviewed"; checkpoint: ReviewedCheckpoint }>
  | Readonly<{ status: "failed"; ticketId: string; attemptId: string; stage: string; retryable: boolean; failure: CommandFailure; workspacePath: string | undefined; branch: string | undefined }>
  | Readonly<{ status: "withdrawn"; ticketId: string; attemptId: string; stage: string; observed: string; workspacePath: string; branch: string; preserved: PreservedAttempt | undefined }>;

/** Called after the attempt workspace directory is reserved, before any target-repository work starts. */
export type AttemptReserved = (attemptId: string, branch: string) => Promise<void>;

/** One successful mutating stage: checkpoint commit, then its main.log trace record. */
async function commitBoundary(config: ProcessConfig, ticket: Ticket, attempt: Attempt, stage: StageName, outcome: StageOutcome): Promise<StageCommitResult> {
  const checkpoint = await commitStage({
    workspacePath: attempt.workspacePath,
    branch: attempt.branch,
    ticketId: ticket.id,
    attemptId: attempt.attemptId,
    stage,
    message: outcome.message,
    expectedHead: outcome.head,
    agentLogReference: outcome.logReference,
    forbiddenSecrets: config.providers.secrets,
  });
  await config.logger.record({
    timestamp: new Date().toISOString(),
    ticketId: ticket.id,
    attemptId: attempt.attemptId,
    stage: commitStages[stage],
    operation: "creating stage checkpoint commit",
    status: "completed",
    parentSha: checkpoint.parentSha,
    checkpointSha: checkpoint.checkpointSha,
    changes: checkpoint.changes,
    agentLogReference: outcome.logReference,
  });
  return checkpoint;
}

/** Run one fresh complete attempt and retain its reviewed checkpoint for graph integration/publication. */
export async function executeReviewedAttempt(
  ticket: Ticket,
  config: ProcessConfig,
  onReserved: AttemptReserved,
  baseline?: WorkspaceBaseline,
  authorize?: StageAuthorization,
): Promise<ReviewedAttemptResult> {
  const workspacesRoot = resolve(config.factoryRoot, ".workspaces");
  let attemptId = randomBytes(3).toString("hex");
  let workspacePath: string | undefined;
  let branch: string | undefined;
  let stage = "reserve";
  try {
    const workspace = await reserveAttempt(workspacesRoot, ticket.slug);
    attemptId = workspace.attemptId;
    workspacePath = workspace.workspacePath;
    branch = workspace.branch;
    stage = "claim";
    await onReserved(attemptId, workspace.branch);
    stage = "workspace";
    const attempt = await createWorkspace(ticket, workspace, baseline);
    stage = "implement";
    const implementation = await implementTicket({ ticket, workspacePath: attempt.workspacePath, branch: attempt.branch, attemptId, harness: config.harness, runAgent: config.runAgent, ...(authorize === undefined ? {} : { authorize }) });
    stage = commitStages.implement;
    const implementationCheckpoint = await commitBoundary(config, ticket, attempt, "implement", implementation);
    stage = "review";
    const review = await reviewTicket({ ticket, workspacePath: attempt.workspacePath, branch: attempt.branch, attemptId, harness: config.harness, runAgent: config.runAgent, ...(authorize === undefined ? {} : { authorize }) });
    stage = commitStages.review;
    const reviewCheckpoint = await commitBoundary(config, ticket, attempt, "review", review);
    return {
      status: "reviewed",
      checkpoint: { ticket, attemptId, workspacePath: attempt.workspacePath, branch: attempt.branch, implementationCheckpoint, reviewCheckpoint, baselineSha: implementationCheckpoint.parentSha, requirementsHash: ticket.requirementsHash },
    };
  } catch (error) {
    if (isAuthorizationWithdrawn(error) && workspacePath !== undefined && branch !== undefined) {
      // The human withdrew authority: push what exists so the work survives, then stop. No checkpoint,
      // no publication, and no status change — the board column is theirs.
      const preserved = await preserveAttemptWorkspace({
        attemptId,
        branch,
        repository: ticket.repository,
        baseBranch: ticket.baseBranch,
        workspacePath,
        secrets: config.providers.secrets,
      }).catch(() => undefined);
      return {
        status: "withdrawn",
        ticketId: ticket.id,
        attemptId,
        stage: error.stage,
        observed: error.observed,
        workspacePath,
        branch,
        preserved,
      };
    }
    const failure = toCommandFailure(error, stage);
    await logSettlementFailure(config, ticket, attemptId, stage, error);
    console.error(`Ticket ${ticket.id} attempt ${attemptId} failed at ${stage}; details recorded in main.log.`);
    return {
      status: "failed",
      ticketId: ticket.id,
      attemptId,
      stage,
      retryable: !stage.includes("commit") && detectAuthorizationLapse(failure.stderr, config.providers.secrets) === undefined,
      failure,
      workspacePath,
      branch,
    };
  }
}
