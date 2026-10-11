import assert from "node:assert/strict";
import { test } from "node:test";
import { pullRequestSchema } from "./harness-agents.js";

test("pull-request content accepts committed change metadata", () => {
  assert.deepEqual(pullRequestSchema.parse({ title: "Fix health endpoint", body: "Verified with curl." }), {
    title: "Fix health endpoint",
    body: "Verified with curl.",
  });
});

test("pull-request content rejects obsolete commit instructions", () => {
  assert.throws(
    () => pullRequestSchema.parse({ commitMessage: "fix: health", title: "Fix health endpoint", body: "Verified." }),
    /Unrecognized key/,
  );
});
