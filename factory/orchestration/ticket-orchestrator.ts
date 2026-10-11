import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { requireCleanRepository, runGit, toCommandFailure, type CommandFailure } from "../shared/git.js";
import type { InvocationLogger } from "../shared/invocation-log.js";
import { runImplementationAgent, runPlanAgent, runPullRequestAgent, runReviewAgent } from "../harness/harness-agents.js";
import { type AgentHarness } from "../sandbox/sandbox.js";
import { annotateAttempt, annotateCompletion, annotateFailure, moveTicket } from "../tickets/ticket-lifecycle.js";
import { validatePlan, type Ticket } from "../tickets/tickets.js";
import { createWorkspace, reserveAttempt } from "../workspace/workspace-service.js";
import { createDraftPullRequest } from "../github/pull-request-service.js";

// Ticket-scoped lifecycle: plan, workspace, implement, review, commit, push, draft pull request, terminal ticket transition.

export interface SolveContext {
  readonly ticketsDir: string;
  readonly factoryRoot: string;
  readonly harness: AgentHarness;
  readonly iteration: number;
  readonly pending: readonly Ticket[];
  readonly completed: readonly string[];
  readonly logger: InvocationLogger;
  readonly githubToken: string;
}

export interface TicketOutcome {
  readonly ticketId: string;
  readonly attemptId: string;
  readonly completed: boolean;
  readonly destination: string;
  readonly failure?: CommandFailure;
}

interface WorkspaceSnapshot {
  readonly head: string;
  readonly status: string;
}

async function snapshot(repository: string): Promise<WorkspaceSnapshot> {
  const head = (await runGit(repository, ["rev-parse", "HEAD"], "reading HEAD commit")).trim();
  const status = (await runGit(repository, ["status", "--porcelain"], "reading worktree status")).trim();
  return { head, status };
}

function requireUnchanged(stage: string, label: string, before: WorkspaceSnapshot, after: WorkspaceSnapshot): void {
  if (after.head !== before.head) {
    throw new Error(`${stage} changed ${label} commits: ${before.head} -> ${after.head}.`);
  }
  if (after.status !== before.status) {
    throw new Error(`${stage} changed ${label} worktree status.`);
  }
}

/** Record one settlement step failure in `main.log` without recursion. */
async function logSettlementFailure(logger: InvocationLogger, ticket: Ticket, attemptId: string, step: string, error: unknown): Promise<void> {
  const failure = toCommandFailure(error, step);
  await logger.record({
    timestamp: new Date().toISOString(),
    ticketId: ticket.id,
    attemptId,
    stage: step,
    operation: failure.operation,
    status: "failed",
    stdout: failure.stdout,
    stderr: failure.stderr,
  });
}

/** Run one complete ticket attempt; every failure is recorded, annotated, and moved to `failed/` without stopping sibling tickets. */
async function solveTicket(ticket: Ticket, context: SolveContext): Promise<TicketOutcome> {
  const workspacesRoot = resolve(context.factoryRoot, ".workspaces");
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
    await runImplementationAgent(attempt, context.harness, context.logger);

    stage = "review";
    await runReviewAgent(attempt, context.harness, context.logger);
    await requireCleanRepository(attempt.workspacePath, `Review for ticket ${ticket.id}`);

    const beforeContent = await snapshot(attempt.workspacePath);
    stage = "pull-request content";
    const content = await runPullRequestAgent(attempt, context.harness, context.logger);
    const afterContent = await snapshot(attempt.workspacePath);
    requireUnchanged("pull-request content stage", "ticket workspace", beforeContent, afterContent);


    stage = "commit count";
    const ahead = Number((await runGit(attempt.workspacePath, ["rev-list", "--count", `origin/${ticket.baseBranch}..HEAD`], "counting commits ahead of base branch")).trim());
    if (ahead < 1) {
      throw new Error(`Ticket branch ${attempt.branch} has no commits ahead of origin/${ticket.baseBranch}.`);
    }

    stage = "final SHA";
    const finalSha = (await runGit(attempt.workspacePath, ["rev-parse", "HEAD"], "reading final commit SHA")).trim();

    stage = "push";
    await runGit(attempt.workspacePath, ["push", "--set-upstream", "origin", attempt.branch], "pushing ticket branch");

    stage = "draft pull request";
    const pullRequest = await createDraftPullRequest({
      token: context.githubToken,
      owner: ticket.githubOwner,
      repository: ticket.githubRepository,
      head: attempt.branch,
      base: ticket.baseBranch,
      title: content.title,
      body: content.body,
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
      await logSettlementFailure(context.logger, ticket, workspace.attemptId, "completion annotation", error);
    }

    stage = "terminal movement";
    try {
      const destination = await moveTicket(ticket.path, resolve(context.ticketsDir, "done"), workspace.attemptId);
      return { ticketId: ticket.id, attemptId: workspace.attemptId, completed: true, destination };
    } catch (error) {
      await logSettlementFailure(context.logger, ticket, workspace.attemptId, "terminal movement", error);
      return { ticketId: ticket.id, attemptId: workspace.attemptId, completed: true, destination: "" };
    }
  } catch (error) {
    const failure = toCommandFailure(error, stage);
    const timestamp = new Date().toISOString();
    await context.logger.record({
      timestamp,
      ticketId: ticket.id,
      attemptId,
      stage,
      operation: failure.operation,
      status: "failed",
      stdout: failure.stdout,
      stderr: failure.stderr,
    });

    // The terminal transition is owned here: annotation and movement each get one guarded attempt, no recursion.
    try {
      await annotateFailure(ticket.path, {
        timestamp,
        attemptId,
        stage,
        command: failure.command,
        exitCode: failure.exitCode,
        stdout: failure.stdout,
        stderr: failure.stderr,
        githubToken: context.githubToken,
      });
    } catch (error2) {
      await logSettlementFailure(context.logger, ticket, attemptId, "failure annotation", error2);
    }

    try {
      const destination = await moveTicket(ticket.path, resolve(context.ticketsDir, "failed"), attemptId);
      return { ticketId: ticket.id, attemptId, completed: false, destination, failure };
    } catch (error2) {
      await logSettlementFailure(context.logger, ticket, attemptId, "terminal movement", error2);
      return { ticketId: ticket.id, attemptId, completed: false, destination: "", failure };
    }
  }
}

/** Plan one iteration from the factory checkout, then run each planned ticket attempt; factory commits or status changes around planning are fatal. */
export async function solveTickets(context: SolveContext): Promise<TicketOutcome[]> {
  const factoryBefore = await snapshot(context.factoryRoot);
  const plan = await runPlanAgent(context.factoryRoot, context.harness, context.iteration, context.pending, context.completed, context.logger);
  const available = new Map(context.pending.map((ticket) => [ticket.id, ticket] as const));
  const planned = validatePlan(plan.output.tickets, available, new Set(context.completed));
  const factoryAfter = await snapshot(context.factoryRoot);
  requireUnchanged("planning stage", "factory", factoryBefore, factoryAfter);

  const outcomes: TicketOutcome[] = [];
  for (const selection of planned) {
    const ticket = available.get(selection.id);
    if (ticket === undefined) {
      throw new Error(`Planner selected unknown ticket ${selection.id}.`);
    }
    outcomes.push(await solveTicket(ticket, context));
  }
  return outcomes;
}
