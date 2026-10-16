import { sleep } from "../../shared/sleep.js";
import { createDependencyWorkflowState, processDependencyCycle } from "./dependency-cycle.js";
import { JobLimiter } from "./job-limiter.js";
import type { ProcessConfig } from "./process-config.js";

// Daemon loop: dependency workflow state remains invocation-local; poll for 10 seconds only when the active queue is empty.

const TICKET_POLL_MS = 10_000;

export async function processTickets(config: ProcessConfig): Promise<void> {
  const limiter = new JobLimiter(config.maxParallel);
  const limitedConfig: ProcessConfig = { ...config, runAgent: limiter.wrap(config.runAgent) };
  const state = createDependencyWorkflowState();
  for (;;) {
    const outcome = await processDependencyCycle(limitedConfig, state);
    if (state.issues.size === 0) {
      console.log(`[poll] No open backlog tickets; sleeping ${TICKET_POLL_MS / 1000} seconds.`);
      await sleep(TICKET_POLL_MS);
    } else if (outcome === "no-runnable") {
      console.log(`[poll] No runnable tickets; sleeping ${TICKET_POLL_MS / 1000} seconds before checking for new or changed tickets.`);
      await sleep(TICKET_POLL_MS);
    }
  }
}
