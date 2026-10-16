import assert from "node:assert/strict";
import { test } from "node:test";
import { renderJsonReport, renderTextReport, type SubmissionReport } from "./submission-report.js";

// The report is the agent's only view of a submission: one stable line per ticket, a refusal line for a
// zero-write stop, and totals. `--json` is one parseable object.

const REPORT: SubmissionReport = {
  ok: false,
  exitCode: 1,
  entries: [
    { source: "tickets/a.md", ticketId: "T-1", outcome: "created", issueNumber: 12, issueUrl: "https://github.com/acme/backlog/issues/12", status: "Ready for development" },
    { source: "tickets/b.md", ticketId: "T-2", outcome: "updated", issueNumber: 13, issueUrl: "https://github.com/acme/backlog/issues/13", status: "Ready for development" },
    { source: "tickets/c.md", ticketId: "T-3", outcome: "unchanged", issueNumber: 14, issueUrl: "https://github.com/acme/backlog/issues/14", status: "Ready for development" },
    { source: "tickets/d.md", ticketId: "T-4", outcome: "failed", reason: "Project Status is Blocked, and only `Staging` accepts a resubmission." },
  ],
  totals: { created: 1, updated: 1, unchanged: 1, failed: 1 },
};

test("the text report gives one line per ticket in batch order, then totals", () => {
  const lines = renderTextReport(REPORT).split("\n");

  assert.deepEqual(lines, [
    "created #12 https://github.com/acme/backlog/issues/12 T-1 tickets/a.md status=Ready for development",
    "updated #13 T-2 tickets/b.md status=Ready for development",
    "unchanged #14 T-3 tickets/c.md status=Ready for development",
    "failed tickets/d.md: Project Status is Blocked, and only `Staging` accepts a resubmission. (T-4)",
    "totals: 1 created, 1 updated, 1 unchanged, 1 failed",
  ]);
});

test("a refused run adds the refusal line above the totals and keeps the ticket lines", () => {
  const refused: SubmissionReport = { ...REPORT, exitCode: 2, failure: "Backlog Project PVT_project_1 is public; the backlog must be a private Project." };

  const lines = renderTextReport(refused).split("\n");

  assert.equal(lines.at(-2), "submission refused: Backlog Project PVT_project_1 is public; the backlog must be a private Project.");
  assert.equal(lines.at(-1), "totals: 1 created, 1 updated, 1 unchanged, 1 failed");
});

test("the JSON report is one object carrying status, entries, and totals", () => {
  const refused: SubmissionReport = { ...REPORT, exitCode: 2, failure: "locked" };

  const parsed = JSON.parse(renderJsonReport(refused)) as Record<string, unknown>;

  assert.deepEqual(Object.keys(parsed).sort(), ["entries", "exitCode", "failure", "ok", "totals"]);
  assert.equal(parsed.exitCode, 2);
  assert.equal(parsed.failure, "locked");
  assert.deepEqual((parsed.entries as { outcome: string }[]).map((entry) => entry.outcome), ["created", "updated", "unchanged", "failed"]);
});

test("a successful report carries no failure field", () => {
  const ok: SubmissionReport = { ...REPORT, ok: true, exitCode: 0 };

  assert.deepEqual(Object.keys(JSON.parse(renderJsonReport(ok)) as Record<string, unknown>).sort(), ["entries", "exitCode", "ok", "totals"]);
});
