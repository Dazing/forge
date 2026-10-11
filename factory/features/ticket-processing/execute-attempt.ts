import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { annotateAttempt, annotateCompletion, annotateStageCheckpoint, moveTicket, type Ticket } from "../tickets/index.js";
import { implementTicket } from "../implement-ticket/index.js";
import { reviewTicket } from "../review-ticket/index.js";
import { publishPullRequest } from "../publish-pull-request/index.js";
import { commitStage, type StageCommitResult, type StageName } from "./stage-commit.js";
import { createWorkspace, reserveAttempt } from "./workspace.js";
import { logSettlementFailure, settleAttemptFailure } from "./settle-attempt.js";
import type { ProcessConfig, TicketOutcome } from "./process-config.js";

// One complete ticket attempt: reserve, attempt annotation, workspace, implementation, implementation
// checkpoint, review, review checkpoint, publication, then guarded completion annotation and movement.
// The runner owns every checkpoint commit; agents never commit. A failed boundary preserves the
// workspace, index, and prior commits, and every failure settles to `failed/` without stopping siblings.

interface Attempt {
  readonly workspacePath: string;
  readonly branch: string;
  readonly attemptId: string;
}

/** Failure-stage labels for the two mutating boundaries. */
const commitStages = { implement: "implementation commit", review: "review commit" } as const;
const annotationStages = { implement: "implementation checkpoint annotation", review: "review checkpoint annotation" } as const;

function stageLogBasename(config: ProcessConfig, ticket: Ticket, attempt: Attempt, stage: StageName): string {
  return config.logger.agentLogBasename(`${stage}-${ticket.id}-${attempt.attemptId}`);
}

/** One stage's validated message plus the HEAD its work started from. */
type StageOutcome = Readonly<{ message: string; head: string }>;

/** One successful mutating stage: checkpoint commit, then its main.log trace record. */
async function commitBoundary(config: ProcessConfig, ticket: Ticket, attempt: Attempt, stage: StageName, outcome: StageOutcome): Promise<StageCommitResult> {
  const agentLogBasename = stageLogBasename(config, ticket, attempt, stage);
  const checkpoint = await commitStage({
    workspacePath: attempt.workspacePath,
    branch: attempt.branch,
    ticketId: ticket.id,
    attemptId: attempt.attemptId,
    stage,
    message: outcome.message,
    expectedHead: outcome.head,
    agentLogBasename,
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
    agentLogBasename,
  });
  return checkpoint;
}

/** Append the ticket-side record of one checkpoint boundary. A failure here is its own stage and never repeats the commit. */
async function annotateBoundary(config: ProcessConfig, ticket: Ticket, attempt: Attempt, stage: StageName, checkpoint: StageCommitResult): Promise<void> {
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
      agentLogBasename: stageLogBasename(config, ticket, attempt, stage),
    });
  } catch (error) {
    // The commit is already durable; the annotation failure is its own stage and never repeats the commit.
    await config.logger.record({ ...record, status: "failed", stderr: String(error) });
    throw error;
  }
}

export async function executeAttempt(ticket: Ticket, config: ProcessConfig): Promise<TicketOutcome> {
  const workspacesRoot = resolve(config.factoryRoot, ".workspaces");
  let attemptId = randomBytes(3).toString("hex");
  let stage = "reserve";
  try {
    const workspace = await reserveAttempt(workspacesRoot, ticket.slug);
    attemptId = workspace.attemptId;
    stage = "attempt annotation";
    await annotateAttempt(ticket.path, {
      timestamp: new Date().toISOString(),
      attemptId: workspace.attemptId,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      repository: ticket.repository,
      baseBranch: ticket.baseBranch,
    });

    stage = "workspace";
    const attempt = await createWorkspace(ticket, workspace);

    stage = "implement";
    const implementation = await implementTicket({ ticket, workspacePath: attempt.workspacePath, branch: attempt.branch, attemptId: attempt.attemptId, harness: config.harness, runAgent: config.runAgent });

    stage = commitStages.implement;
    const implementationCheckpoint = await commitBoundary(config, ticket, attempt, "implement", implementation);

    stage = annotationStages.implement;
    await annotateBoundary(config, ticket, attempt, "implement", implementationCheckpoint);

    // The reviewer starts from the clean implementation checkpoint.
    stage = "review";
    const review = await reviewTicket({ ticket, workspacePath: attempt.workspacePath, branch: attempt.branch, attemptId: attempt.attemptId, harness: config.harness, runAgent: config.runAgent });

    stage = commitStages.review;
    const reviewCheckpoint = await commitBoundary(config, ticket, attempt, "review", review);

    stage = annotationStages.review;
    await annotateBoundary(config, ticket, attempt, "review", reviewCheckpoint);

    // Publication is read-only: it starts from the clean review checkpoint and pushes the full stage history.
    stage = "publish";
    const { finalSha, pullRequest, squashPreference } = await publishPullRequest({
      ticket,
      workspacePath: attempt.workspacePath,
      branch: attempt.branch,
      attemptId: attempt.attemptId,
      harness: config.harness,
      runAgent: config.runAgent,
      gitProvider: config.gitProvider,
      onContentComplete: (head) => config.logger.record({
        timestamp: new Date().toISOString(),
        ticketId: ticket.id,
        attemptId: attempt.attemptId,
        stage: "pull-request content",
        operation: "generating pull-request content",
        status: "completed",
        checkpointSha: head,
        changes: "unchanged",
        agentLogBasename: config.logger.agentLogBasename(`pull-request-${ticket.id}-${attempt.attemptId}`),
      }),
    });


    stage = "completion annotation";
    try {
      await annotateCompletion(ticket.path, {
        timestamp: new Date().toISOString(),
        attemptId: workspace.attemptId,
        workspacePath: attempt.workspacePath,
        branch: attempt.branch,
        baseBranch: ticket.baseBranch,
        finalSha,
        pullRequestUrl: pullRequest.url,
        squashPreference,
      });
    } catch (error) {
      await logSettlementFailure(config, ticket, workspace.attemptId, "completion annotation", error);
    }

    stage = "terminal movement";
    try {
      const destination = await moveTicket(ticket.path, resolve(config.ticketsDir, "done"), workspace.attemptId);
      return { ticketId: ticket.id, attemptId: workspace.attemptId, completed: true, destination };
    } catch (error) {
      await logSettlementFailure(config, ticket, workspace.attemptId, "terminal movement", error);
      return { ticketId: ticket.id, attemptId: workspace.attemptId, completed: true, destination: "" };
    }
  } catch (error) {
    return settleAttemptFailure(ticket, attemptId, stage, error, config);
  }
}
