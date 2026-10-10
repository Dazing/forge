import { createSandbox } from "@ai-hero/sandcastle";
import { runImplementationAgent, runMergeAgent, runPlanAgent, runReviewAgent } from "../harness/harness-agents.js";
import { sandboxProvider, requireCleanSandbox, type AgentHarness } from "../sandbox/sandbox.js";
import { runGit } from "../shared/git.js";
import { validatePlan, type Ticket } from "../tickets/tickets.js";

// Per-iteration ticket loop moved from main.ts: planner, per-ticket implement/review, merge, and merge verification.

async function solveTicket(repo: string, harness: AgentHarness, ticket: Ticket): Promise<Ticket> {
  console.log(`[${ticket.id}] Starting implementation: ${ticket.title}`);
  await using sandbox = await createSandbox({
    cwd: repo,
    sandbox: sandboxProvider(harness),
    branch: ticket.branch,
  });

  const implementation = await runImplementationAgent(sandbox, ticket, harness);
  if (implementation.commits.length === 0) {
    throw new Error(`Implementation for ticket ${ticket.id} completed without a commit.`);
  }
  console.log(
    `[${ticket.id}] Implementation complete (${implementation.commits.length} commit(s)); starting review.`,
  );

  await runReviewAgent(sandbox, ticket, harness);
  await requireCleanSandbox(sandbox, `Review for ticket ${ticket.id}`);
  console.log(`[${ticket.id}] Review complete.`);
  return ticket;
}

/** Run one full iteration: plan, per-ticket implement/review, merge, and merge verification; returns the implemented tickets. */
export async function solveTickets(
  repo: string,
  harness: AgentHarness,
  iteration: number,
  pending: readonly Ticket[],
  completed: ReadonlySet<string>,
  allTickets: ReadonlyMap<string, Ticket>,
): Promise<Ticket[]> {
  console.log(`\n=== [planning] Iteration ${iteration} ===\n`);

  const planResult = await runPlanAgent(repo, harness, iteration, pending, [...completed]);
  if (planResult.commits.length > 0) {
    throw new Error("Planner modified the target repository; planning must be read-only.");
  }
  const planningStatus = await runGit(repo, ["status", "--porcelain"], "checking planner worktree cleanliness");
  if (planningStatus.trim().length > 0) {
    throw new Error("Planner left uncommitted changes in the target repository.");
  }
  const planned = validatePlan(planResult.output.tickets, allTickets, completed);
  if (planned.length === 0) {
    throw new Error(`Planner selected no work while ${pending.length} supplied ticket(s) remain.`);
  }

  console.log(
    `[planning] Selected ${planned.length} ticket(s): ${planned.map((ticket) => ticket.id).join(", ")}`,
  );

  const outcomes = await Promise.allSettled(
    planned.map((plannedTicket) => {
      const ticket = allTickets.get(plannedTicket.id);
      if (!ticket) throw new Error(`Internal error: missing ticket ${plannedTicket.id}.`);
      return solveTicket(repo, harness, ticket);
    }),
  );

  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [`${planned[index]?.id ?? `index ${index}`}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(`Implementation/review failed:\n- ${failures.join("\n- ")}`);
  }
  const implemented = outcomes.map((outcome) => {
    if (outcome.status !== "fulfilled") throw new Error("Unreachable failed outcome.");
    return outcome.value;
  });

  console.log(
    `\n=== [merge] Merging ${implemented.length} ticket(s): ${implemented.map((ticket) => ticket.id).join(", ")} ===\n`,
  );

  await runMergeAgent(repo, harness, iteration, implemented);

  for (const ticket of implemented) {
    await runGit(repo, ["merge-base", "--is-ancestor", ticket.branch, "HEAD"], `verifying merge of ${ticket.branch}`);
  }
  const mergeStatus = await runGit(repo, ["status", "--porcelain"], "checking merged worktree cleanliness");
  if (mergeStatus.trim().length > 0) {
    throw new Error("Merge stage left uncommitted changes in the target repository.");
  }

  console.log(`[merge] Complete: ${implemented.map((ticket) => ticket.id).join(", ")}`);
  return implemented;
}
