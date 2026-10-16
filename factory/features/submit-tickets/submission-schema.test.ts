import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commentMarker,
  parseSubmissionRecord,
  submissionOperationKey,
  submissionStatePath,
  submissionTotals,
  type SubmissionEntry,
} from "./submission-schema.js";

// The local sidecar is the durability record the CLI trusts, so it is validated strictly, and the
// operation key is the idempotency key for every effect.

const VALID_RECORD = {
  version: 1,
  backlogRepository: "acme/backlog",
  projectId: "PVT_project_1",
  issueNumber: 12,
  issueNodeId: "ISSIONODE_12",
  issueUrl: "https://github.com/acme/backlog/issues/12",
  sourceHash: "a".repeat(64),
  requirementsHash: "b".repeat(64),
  lastComment: { id: 42, url: "https://github.com/acme/backlog/issues/12#issuecomment-42", marker: "<!-- factory:comment:T-1:abcdef012345 -->", sourceHash: "c".repeat(64), postedAt: "2026-10-16T10:00:01.000Z" },
  submittedAt: "2026-10-16T10:00:00.000Z",
};

test("the operation key is ticket id plus source hash and the marker is its HTML comment form", () => {
  const key = submissionOperationKey("T-1", "c".repeat(64));

  assert.equal(key, `factory:comment:T-1:${"c".repeat(64).slice(0, 12)}`);
  assert.equal(commentMarker(key), `<!-- factory:comment:T-1:${"c".repeat(64).slice(0, 12)} -->`);
  assert.equal(submissionOperationKey("T-1", "c".repeat(64)), key, "the same content always yields the same key");
});

test("submission state is a sibling of the source with the .submission.json suffix", () => {
  assert.equal(submissionStatePath("tickets/T-1-first.md"), "tickets/T-1-first.submission.json");
  assert.equal(submissionStatePath("tickets/nested/T-1-first.markdown"), "tickets/nested/T-1-first.submission.json");
});

test("a valid sidecar parses with its exact fields", () => {
  const record = parseSubmissionRecord("/tmp/tickets/first.submission.json", JSON.stringify(VALID_RECORD));

  assert.deepEqual(record, VALID_RECORD);
});

test("a sidecar that is not an object, is unparseable, carries an extra field, or has the wrong version fails naming the path", () => {
  const cases: ReadonlyArray<readonly [string, RegExp]> = [
    ["[]", /must be a JSON object/],
    ["not json", /is not valid JSON/],
    [JSON.stringify({ ...VALID_RECORD, extraField: "surprise" }), /unrecognised field: extraField/],
    [JSON.stringify({ ...VALID_RECORD, version: 2 }), /version Invalid input: expected 1/],
  ];
  for (const [text, expectation] of cases) {
    assert.throws(() => parseSubmissionRecord("/tmp/tickets/first.submission.json", text), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /first\.submission\.json/);
      assert.match(error.message, expectation);
      return true;
    }, text);
  }
});

test("totals count every outcome", () => {
  const entries: SubmissionEntry[] = [
    { source: "a.md", ticketId: "T-1", outcome: "created", issueNumber: 1, issueUrl: "https://github.com/acme/backlog/issues/1" },
    { source: "b.md", ticketId: "T-2", outcome: "updated", issueNumber: 2, issueUrl: "https://github.com/acme/backlog/issues/2" },
    { source: "c.md", ticketId: "T-3", outcome: "unchanged", issueNumber: 3, issueUrl: "https://github.com/acme/backlog/issues/3" },
    { source: "d.md", ticketId: "T-4", outcome: "failed", reason: "boom" },
  ];

  assert.deepEqual(submissionTotals(entries), { created: 1, updated: 1, unchanged: 1, failed: 1 });
});
