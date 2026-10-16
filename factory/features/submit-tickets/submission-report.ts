import type { SubmissionEntry, SubmissionTotals } from "./submission-schema.js";

// Agent-free, deterministic, credential-free reporting for `npm run tickets -- submit` (plan §3 D12):
// one stable text line per ticket plus totals, or one JSON object on stdout with `--json`.

/** A rendered submission report: the process exit code, optional gate failure, and the batch entries. */
export type SubmissionReport = Readonly<{
  ok: boolean;
  exitCode: number;
  entries: readonly SubmissionEntry[];
  totals: SubmissionTotals;
  failure?: string;
}>;

function entryLine(entry: SubmissionEntry): string {
  if (entry.outcome === "failed") {
    return `failed ${entry.source}: ${entry.reason ?? "unknown failure"}${entry.ticketId.length === 0 ? "" : ` (${entry.ticketId})`}`;
  }
  const issue = entry.issueNumber === undefined ? entry.source : `#${entry.issueNumber}`;
  const url = entry.outcome === "created" && entry.issueUrl !== undefined ? ` ${entry.issueUrl}` : "";
  const status = entry.status === undefined ? "" : ` status=${entry.status}`;
  return `${entry.outcome} ${issue}${url} ${entry.ticketId} ${entry.source}${status}`;
}

/** The stable text report: one line per ticket in batch order, then the totals line. */
export function renderTextReport(report: SubmissionReport): string {
  const lines = [...report.entries.map(entryLine)];
  if (report.failure !== undefined) lines.push(`submission refused: ${report.failure}`);
  const { created, updated, unchanged, failed } = report.totals;
  lines.push(`totals: ${created} created, ${updated} updated, ${unchanged} unchanged, ${failed} failed`);
  return lines.join("\n");
}

/** The machine report: exactly one JSON object with entries, totals, and the exit status. */
export function renderJsonReport(report: SubmissionReport): string {
  return JSON.stringify({
    ok: report.ok,
    exitCode: report.exitCode,
    entries: report.entries,
    totals: report.totals,
    ...(report.failure === undefined ? {} : { failure: report.failure }),
  }, null, 2);
}
