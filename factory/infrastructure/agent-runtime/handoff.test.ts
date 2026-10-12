import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createAgentHandoff } from "./handoff.js";

test("handoff definition exposes one strict stage-shaped schema and revalidates on the host", () => {
  const definition = createAgentHandoff(
    "Submit the completed test result.",
    z.strictObject({ message: z.string().min(1).max(20) }),
  );

  assert.equal(definition.toolName, "submit_handoff");
  assert.equal(definition.description, "Submit the completed test result.");
  assert.deepEqual(definition.inputSchema.required, ["message"]);
  assert.deepEqual(definition.inputSchema.properties, {
    message: { type: "string", minLength: 1, maxLength: 20 },
  });
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.deepEqual(definition.validate({ message: "complete" }), { message: "complete" });
  assert.throws(() => definition.validate({ message: "", extra: true }), /validation failed/i);
});
