import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketAgent } from "./create-agent.js";

for (const harness of ["pi", "oh-my-pi"] as const) {
  test(`${harness} lowercase tool starts become human-readable log text`, () => {
    const agent = ticketAgent(harness);
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "edit",
      args: { path: "factory/main.ts", oldText: "before", newText: "after" },
    });

    assert.deepEqual(agent.parseStreamLine(line), [{ type: "text", text: "Tool: edit factory/main.ts" }]);
  });
}
