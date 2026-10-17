import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";
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

  test(`${harness} handoff tool logs omit payload fields`, () => {
    const agent = ticketAgent(harness);
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call-2",
      toolName: "submit_handoff",
      args: { title: "secret title", body: "secret body" },
    });

    assert.deepEqual(agent.parseStreamLine(line), [{ type: "text", text: "Tool: submit_handoff [payload omitted]" }]);
  });

  test(`${harness} preserves model request failure instead of treating it as an omitted handoff`, () => {
    const agent = ticketAgent(harness);
    assert.equal(agent.getFailure(), undefined);
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "400: controlled model failure",
        content: [],
      },
    });
    assert.deepEqual(agent.parseStreamLine(line), []);
    assert.match(agent.getFailure()?.message ?? "", /model request failed: 400: controlled model failure/);
  });

  test(`${harness} successful assistant messages do not become infrastructure failures`, () => {
    const agent = ticketAgent(harness);
    agent.parseStreamLine(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "error" }] },
    }));
    assert.equal(agent.getFailure(), undefined);
  });
}

const rootModelsPath = resolve(import.meta.dirname, "../../../models.json");
const catalogIdsSchema = z.object({
  providers: z.record(z.string(), z.object({ models: z.array(z.object({ id: z.string() })) })),
});

test("both harnesses launch with the single model id declared by the workspace-root catalog", () => {
  const catalog = catalogIdsSchema.parse(JSON.parse(readFileSync(rootModelsPath, "utf8")) as unknown);
  const catalogIds = Object.values(catalog.providers).flatMap((provider) => provider.models.map((model) => model.id));
  assert.equal(catalogIds.length, 1);

  for (const harness of ["pi", "oh-my-pi"] as const) {
    const { command } = ticketAgent(harness).buildPrintCommand({ prompt: "p", dangerouslySkipPermissions: false });
    const launchPattern = new RegExp(`--model'?\\s+'?${catalogIds[0]}'?`);
    assert.ok(
      launchPattern.test(command),
      `${harness} must launch the catalog model, command was: ${command}`,
    );
  }
});
