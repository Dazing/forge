import { resolve } from "node:path";
import { createSandbox } from "@ai-hero/sandcastle";
import { parseArgs } from "./cli/cli.js";
import { runImplementationAgent, runMergeAgent, runPlanAgent, runReviewAgent } from "./harness/harness-agents.js";
import { preflightSandbox, requireCleanSandbox, sandboxProvider } from "./sandbox/sandbox.js";
import { runGit } from "./shared/git.js";
import { requireDirectory } from "./shared/paths.js";
import { loadTickets, validatePlan } from "./tickets/tickets.js";

// Composition root for the Sandcastle runner: the iteration loop and ticket bookkeeping.
// CLI parsing lives in cli/cli.ts, git and path checks in shared/, sandbox preflight in sandbox/sandbox.ts,
// and agent stage runs in harness/harness-agents.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

const MAX_ITERATIONS = 10;

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const repo = resolve(options.repo);
  await requireDirectory(repo, "Target repository");
  await runGit(repo, ["rev-parse", "--git-dir"], "validating --repo");
  await preflightSandbox(options.agentHarness);
  const initialStatus = await runGit(repo, ["status", "--porcelain"], "checking initial worktree cleanliness");
  if (initialStatus.trim().length > 0) {
    throw new Error("Target repository must have a clean worktree before Sandcastle starts.");
  }
  const tickets = await loadTickets(options.ticketPaths);
  const allTickets = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const completed = new Set<string>();

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const pending = tickets.filter((ticket) => !completed.has(ticket.id));
    if (pending.length === 0) break;
    console.log(`\n=== [planning] Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

    const planResult = await runPlanAgent(repo, options.agentHarness, iteration, pending, [...completed]);
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
      planned.map(async (plannedTicket) => {
        const ticket = allTickets.get(plannedTicket.id);
        if (!ticket) throw new Error(`Internal error: missing ticket ${plannedTicket.id}.`);

        console.log(`[${ticket.id}] Starting implementation: ${ticket.title}`);
        await using sandbox = await createSandbox({
          cwd: repo,
          sandbox: sandboxProvider(options.agentHarness),
          branch: ticket.branch,
        });

        const implementation = await runImplementationAgent(sandbox, ticket, options.agentHarness);
        if (implementation.commits.length === 0) {
          throw new Error(`Implementation for ticket ${ticket.id} completed without a commit.`);
        }
        console.log(
          `[${ticket.id}] Implementation complete (${implementation.commits.length} commit(s)); starting review.`,
        );

        await runReviewAgent(sandbox, ticket, options.agentHarness);
        await requireCleanSandbox(sandbox, `Review for ticket ${ticket.id}`);
        console.log(`[${ticket.id}] Review complete.`);
        return ticket;
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

    await runMergeAgent(repo, options.agentHarness, iteration, implemented);

    for (const ticket of implemented) {
      await runGit(repo, ["merge-base", "--is-ancestor", ticket.branch, "HEAD"], `verifying merge of ${ticket.branch}`);
    }
    const mergeStatus = await runGit(repo, ["status", "--porcelain"], "checking merged worktree cleanliness");
    if (mergeStatus.trim().length > 0) {
      throw new Error("Merge stage left uncommitted changes in the target repository.");
    }

    for (const ticket of implemented) completed.add(ticket.id);
    console.log(`[merge] Complete: ${implemented.map((ticket) => ticket.id).join(", ")}`);
  }

  if (completed.size !== tickets.length) {
    const remaining = tickets.filter((ticket) => !completed.has(ticket.id)).map((ticket) => ticket.id);
    throw new Error(`Ten planning iterations ended with uncompleted tickets: ${remaining.join(", ")}`);
  }
  console.log(`\nAll ${completed.size} supplied ticket(s) completed.`);
}

await run();
