import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { annotateAttempt, annotateCompletion, moveTicket, type Ticket } from "../tickets/index.js";
import { implementTicket } from "../implement-ticket/index.js";
import { reviewTicket } from "../review-ticket/index.js";
import { publishPullRequest } from "../publish-pull-request/index.js";
import { createWorkspace, reserveAttempt } from "./workspace.js";
import { logSettlementFailure, settleAttemptFailure } from "./settle-attempt.js";
import type { ProcessConfig, TicketOutcome } from "./process-config.js";

// One complete ticket attempt: reserve, attempt annotation, workspace, implementation, review, publication,
// then guarded completion annotation and movement. Every failure settles to `failed/` without stopping sibling attempts.

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
    await implementTicket({ ticket, workspacePath: attempt.workspacePath, branch: attempt.branch, attemptId: attempt.attemptId, harness: config.harness, runAgent: config.runAgent });

    stage = "review";
    await reviewTicket({ ticket, workspacePath: attempt.workspacePath, branch: attempt.branch, attemptId: attempt.attemptId, harness: config.harness, runAgent: config.runAgent });

    stage = "publish";
    const { finalSha, pullRequest } = await publishPullRequest({
      ticket,
      workspacePath: attempt.workspacePath,
      branch: attempt.branch,
      attemptId: attempt.attemptId,
      harness: config.harness,
      runAgent: config.runAgent,
      gitProvider: config.gitProvider,
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
