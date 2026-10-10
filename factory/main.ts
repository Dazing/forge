import { resolve } from "node:path";
import { parseArgs } from "./cli/cli.js";
import { solveTickets } from "./orchestration/ticket-orchestrator.js";
import { preflightSandbox } from "./sandbox/sandbox.js";
import { runGit } from "./shared/git.js";
import { requireDirectory } from "./shared/paths.js";
import { sleep } from "./shared/sleep.js";
import { listTicketPaths, loadTickets, type Ticket } from "./tickets/tickets.js";

// Composition root for the Sandcastle runner: the daemon main loop and ticket bookkeeping.
// CLI parsing lives in cli/cli.ts, the per-iteration ticket loop in orchestration/ticket-orchestrator.ts,
// git and path checks in shared/, sandbox preflight in sandbox/sandbox.ts, and agent stage runs in harness/harness-agents.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

const TICKET_POLL_MS = 10_000;

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const repo = resolve(options.repo);
  await requireDirectory(repo, "Target repository");
  await runGit(repo, ["rev-parse", "--git-dir"], "validating --repo");
  const ticketsDir = resolve(options.ticketsDir);
  await requireDirectory(ticketsDir, "Ticket directory");
  await preflightSandbox(options.agentHarness);
  const initialStatus = await runGit(repo, ["status", "--porcelain"], "checking initial worktree cleanliness");
  if (initialStatus.trim().length > 0) {
    throw new Error("Target repository must have a clean worktree before Sandcastle starts.");
  }

  const allTickets = new Map<string, Ticket>();
  const completed = new Set<string>();
  let iteration = 0;
  const stayAlive = true;
  while (stayAlive) {
    iteration++;
    const discovered = await loadTickets(await listTicketPaths(ticketsDir));
    for (const ticket of discovered) {
      if (!allTickets.has(ticket.id)) allTickets.set(ticket.id, ticket);
    }
    const pending = [...allTickets.values()].filter((ticket) => !completed.has(ticket.id));
    if (pending.length === 0) {
      console.log(`[poll] No pending tickets; sleeping ${TICKET_POLL_MS / 1000} seconds.`);
      await sleep(TICKET_POLL_MS);
      continue;
    }

    const implemented = await solveTickets(repo, options.agentHarness, iteration, pending, completed, allTickets);
    for (const ticket of implemented) completed.add(ticket.id);
    console.log(`merged ${implemented.map((ticket) => ticket.id).join(", ")}; ${completed.size}/${allTickets.size} ticket(s) completed`);
  }
}

await run();
