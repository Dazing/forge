import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./cli.js";

test("execution limits default conservatively and accept positive integers", () => {
  assert.deepEqual(parseArgs([]), { agentHarness: "pi", maxParallel: 1, ticketAttemptsPerCycle: 3 });
  assert.deepEqual(parseArgs(["--max-parallel", "4", "--ticket-attempts-per-cycle", "2"]), { agentHarness: "pi", maxParallel: 4, ticketAttemptsPerCycle: 2 });
  assert.deepEqual(parseArgs(["--agent-harness", "oh-my-pi"]), { agentHarness: "oh-my-pi", maxParallel: 1, ticketAttemptsPerCycle: 3 });
});

test("execution limits reject zero, fractions, text, and repeats", () => {
  for (const [flag, value] of [["--max-parallel", "0"], ["--max-parallel", "1.5"], ["--ticket-attempts-per-cycle", "no"]] as const) {
    assert.throws(() => parseArgs([flag, value]), /positive integer/);
  }
  assert.throws(() => parseArgs(["--max-parallel", "1", "--max-parallel", "2"]), /only once/);
  assert.throws(() => parseArgs(["--agent-harness", "codex"]), /Unknown agent harness/);
  assert.throws(() => parseArgs(["--tickets-dir", "tickets"]), /Unknown argument/);
});
