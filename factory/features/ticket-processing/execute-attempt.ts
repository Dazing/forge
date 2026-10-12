import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { annotateAttempt, annotateFailure, annotateStageCheckpoint, type Ticket } from "../tickets/index.js";
import { implementTicket } from "../implement-ticket/index.js";
import { reviewTicket } from "../review-ticket/index.js";
import { toCommandFailure, type CommandFailure } from "../../infrastructure/git-provider/git.js";
import { commitStage, type StageCommitResult, type StageName } from "./stage-commit.js";
import { createWorkspace, reserveAttempt, type WorkspaceBaseline } from "./workspace.js";
import { logSettlementFailure } from "./settle-attempt.js";
import type { ProcessConfig } from "./process-config.js";

// One fresh complete ticket attempt: reserve, annotate, create a dependency-based workspace, then
// implement and review with runner-owned checkpoint/trace/annotation boundaries. Publication is
// group-owned. Failed workspaces remain retained; only reviewed checkpoints enter workflow state.

interface Attempt {
  readonly workspacePath: string;
  readonly branch: string;
  readonly attemptId: string;
}

/** Failure-stage labels for the two mutating boundaries. */
const commitStages = { implement: "implementation commit", review: "review commit" } as const;
const annotationStages = { implement: "implementation checkpoint annotation", review: "review checkpoint annotation" } as const;

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
  | Readonly<{ status: "failed"; ticketId: string; attemptId: string; stage: string; retryable: boolean; failure: CommandFailure }>;


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
    forbiddenSecrets: config.gitProvider.secrets(),
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

async function annotateBoundary(config: ProcessConfig, ticket: Ticket, attempt: Attempt, stage: StageName, checkpoint: StageCommitResult, logReference: string): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    ticketId: ticket.id,
    attemptId: attempt.attemptId,
    stage: annotationStages[stage],
    operation: "annotating stage checkpoint",
  };
  try {
    await annotateStageCheckpoint(ticket.path, {
      timestamp: new Date().toISOString(),
      attemptId: attempt.attemptId,
      stage,
      parentSha: checkpoint.parentSha,
      checkpointSha: checkpoint.checkpointSha,
      changes: checkpoint.changes,
      agentLogReference: logReference,
    });
  } catch (error) {
    // The commit is already durable; the annotation failure is its own stage and never repeats the commit.
    await config.logger.record({ ...record, status: "failed", stderr: String(error) });
    throw error;
  }
}

/** Run one fresh complete attempt and retain its reviewed checkpoint for graph integration/publication. */
export async function executeReviewedAttempt(ticket: Ticket, config: ProcessConfig, baseline?: WorkspaceBaseline): Promise<ReviewedAttemptResult> {
  const workspacesRoot = resolve(config.factoryRoot, ".workspaces");
  let attemptId = randomBytes(3).toString("hex");
  let stage = "reserve";
  try {
    const workspace = await reserveAttempt(workspacesRoot, ticket.slug);
    attemptId = workspace.attemptId;
    stage = "attempt annotation";
    await annotateAttempt(ticket.path, {
      timestamp: new Date().toISOString(),
      attemptId,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      repository: ticket.repository,
      baseBranch: ticket.baseBranch,
    });
    stage = "workspace";
    const attempt = await createWorkspace(ticket, workspace, baseline);
    stage = "implement";
    const implementation = await implementTicket({ ticket, workspacePath: attempt.workspacePath, branch: attempt.branch, attemptId, harness: config.harness, runAgent: config.runAgent });
    stage = commitStages.implement;
    const implementationCheckpoint = await commitBoundary(config, ticket, attempt, "implement", implementation);
    stage = annotationStages.implement;
    await annotateBoundary(config, ticket, attempt, "implement", implementationCheckpoint, implementation.logReference);
    stage = "review";
    const review = await reviewTicket({ ticket, workspacePath: attempt.workspacePath, branch: attempt.branch, attemptId, harness: config.harness, runAgent: config.runAgent });
    stage = commitStages.review;
    const reviewCheckpoint = await commitBoundary(config, ticket, attempt, "review", review);
    stage = annotationStages.review;
    await annotateBoundary(config, ticket, attempt, "review", reviewCheckpoint, review.logReference);
    return {
      status: "reviewed",
      checkpoint: { ticket, attemptId, workspacePath: attempt.workspacePath, branch: attempt.branch, implementationCheckpoint, reviewCheckpoint, baselineSha: implementationCheckpoint.parentSha, requirementsHash: ticket.requirementsHash },
    };
  } catch (error) {
    const failure = toCommandFailure(error, stage);
    await logSettlementFailure(config, ticket, attemptId, stage, error);
    console.error(`Ticket ${ticket.id} attempt ${attemptId} failed at ${stage}; details recorded in main.log and the ticket.`);
    try {
      await annotateFailure(ticket.path, {
        timestamp: new Date().toISOString(),
        attemptId,
        stage,
        command: failure.command,
        exitCode: failure.exitCode,
        stdout: failure.stdout,
        stderr: failure.stderr,
        secret: config.gitProvider.credential,
      });
    } catch (annotationError) {
      await logSettlementFailure(config, ticket, attemptId, "failure annotation", annotationError);
    }
    return {
      status: "failed",
      ticketId: ticket.id,
      attemptId,
      stage,
      retryable: !stage.includes("commit") && !stage.includes("checkpoint annotation"),
      failure,
    };
  }
}

