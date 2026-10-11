import { sleep } from "../../shared/sleep.js";
import { listTicketPaths } from "../tickets/index.js";
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
    await processDependencyCycle(limitedConfig, state);
    if ((await listTicketPaths(config.ticketsDir)).length === 0) {
      console.log(`[poll] No pending tickets; sleeping ${TICKET_POLL_MS / 1000} seconds.`);
      await sleep(TICKET_POLL_MS);
    }
  }
}
