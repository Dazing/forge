import { sleep } from "../../shared/sleep.js";
import type { Ticket } from "../tickets/index.js";
import { processIteration } from "./process-iteration.js";
import type { ProcessConfig } from "./process-config.js";

// Daemon loop: poll the ticket directory every 10 seconds when nothing is pending; in-memory known/terminal bookkeeping.

const TICKET_POLL_MS = 10_000;

export async function processTickets(config: ProcessConfig): Promise<void> {
  const known = new Map<string, Ticket>();
  const terminal = new Set<string>();
  for (;;) {
    const outcomes = await processIteration(config, known, terminal);
    if (outcomes.length === 0 && known.size === 0) {
      console.log(`[poll] No pending tickets; sleeping ${TICKET_POLL_MS / 1000} seconds.`);
      await sleep(TICKET_POLL_MS);
    }
  }
}
