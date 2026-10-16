import assert from "node:assert/strict";
import { test } from "node:test";
import { operationKey, PUBLICATION_RECORD_VERSION, publicationIntentSchema, publicationResultSchema } from "./publication-record.js";

const intent = {
  version: PUBLICATION_RECORD_VERSION,
  operationKey: "factory:publication:group-1-a1b2c3d4e5f6:group-1",
  groupId: "group-1",
  provider: "github",
  repository: "git@github.com:acme/app.git",
  baseBranch: "main",
  baseSha: "1111111111111111111111111111111111111111",
  head: "agent-tickets/fix-1a2b3c",
  sourceSha: "2222222222222222222222222222222222222222",
  title: "Fix login redirect",
  body: "Body",
  mergeStrategy: "squash",
  included: [{ ticketId: "ticket-1", issueNumber: 7, issueNodeId: "I_kwDO1234", requirementsHash: "a".repeat(64) }],
  recordedAt: "2026-10-16T00:00:00.000Z",
};

test("operation keys are deterministic per kind, subject, and detail", () => {
  assert.equal(operationKey("start", "ticket-1", "1a2b3c"), "factory:start:ticket-1:1a2b3c");
  assert.equal(operationKey("failure", "ticket-1", "1a2b3c"), "factory:failure:ticket-1:1a2b3c");
});

test("subjects and details canonicalize to one key-safe segment", () => {
  assert.equal(operationKey("publication", "issue-7", "https://github.com/acme/app/pull/123"), "factory:publication:issue-7:https-github.com-acme-app-pull-123");
  assert.equal(operationKey("failure", "issue-7", "implementation failed: exit 1"), "factory:failure:issue-7:implementation-failed-exit-1");
});

for (const [label, parts] of [
  ["traversal", ["../..", "1a2b3c"]],
  ["punctuation only", ["///", "1a2b3c"]],
  ["empty subject", ["", "1a2b3c"]],
  ["empty detail", ["ticket-1", "   "]],
] as const) {
  test(`an operation key with ${label} is rejected before any effect is recorded`, () => {
    assert.throws(() => operationKey("start", parts[0], parts[1]), /unsafe kind, subject, or detail/);
  });
}

test("an intent decodes with its exact included membership and requirements hashes", () => {
  const decoded = publicationIntentSchema.parse(intent);
  assert.deepEqual(decoded.included, intent.included);
});

test("an intent from an unknown record version, a malformed operation key, an empty membership, or a truncated requirements hash is rejected", () => {
  assert.throws(() => publicationIntentSchema.parse({ ...intent, version: 2 }));
  assert.throws(() => publicationIntentSchema.parse({ ...intent, operationKey: "user:publication:group-1:x" }));
  assert.throws(() => publicationIntentSchema.parse({ ...intent, included: [] }));
  assert.throws(() => publicationIntentSchema.parse({ ...intent, included: [{ ...intent.included[0]!, requirementsHash: "abc" }] }));
});

test("an intent carrying an unexpected field fails closed instead of partially decoding", () => {
  assert.throws(() => publicationIntentSchema.parse({ ...intent, credential: "ghu_secret" }));
});

test("a result requires the provider identity and merge preference alongside its full intent", () => {
  const result = publicationResultSchema.parse({
    ...intent,
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/acme/app/pull/42",
    squashPreference: "unsupported",
    publishedAt: "2026-10-16T00:05:00.000Z",
  });
  assert.equal(result.pullRequestNumber, 42);
  assert.equal(result.groupId, "group-1");
  assert.throws(() => publicationResultSchema.parse({ ...intent, pullRequestUrl: "api.github.com/repos/acme/app/pulls/42" }));
  assert.throws(() => publicationResultSchema.parse({ ...intent, squashPreference: "merge" }));
});
