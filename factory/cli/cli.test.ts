import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./cli.js";

test("execution limits default conservatively and accept positive integers", () => {
  assert.deepEqual(parseArgs(["--tickets-dir", "tickets"]), { ticketsDir: "tickets", agentHarness: "pi", maxParallel: 1, ticketAttemptsPerCycle: 3 });
  assert.deepEqual(parseArgs(["--tickets-dir", "tickets", "--max-parallel", "4", "--ticket-attempts-per-cycle", "2"]), { ticketsDir: "tickets", agentHarness: "pi", maxParallel: 4, ticketAttemptsPerCycle: 2 });
});

test("execution limits reject zero, fractions, text, and repeats", () => {
  for (const [flag, value] of [["--max-parallel", "0"], ["--max-parallel", "1.5"], ["--ticket-attempts-per-cycle", "no"]] as const) {
    assert.throws(() => parseArgs(["--tickets-dir", "tickets", flag, value]), /positive integer/);
  }
  assert.throws(() => parseArgs(["--tickets-dir", "tickets", "--max-parallel", "1", "--max-parallel", "2"]), /only once/);
});
