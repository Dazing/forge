import type {
  CheckResult,
  PullRequestAttemptRequest,
  PullRequestReport,
  StageReport,
} from "./contracts.js";

export function buildPullRequestPrompt(request: PullRequestAttemptRequest): string {
  const reportExample = JSON.stringify({
    status: "blocked",
    title: "Concise pull-request title",
    summary: ["Describe one material change and why it matters."],
    eli5: "Explain what goes in, what changes, and what comes out in everyday language.",
    playByPlay: [{
      explanation: "Describe one execution step and why it matters.",
      references: ["path/to/file.ts:10"],
    }],
    evidence: ["Name the code and supplied verification evidence used for the explanation."],
    unresolvedIssues: ["State the precise blocker; use an empty array only when none remain."],
  }, null, 2);

  return `# Pull-request draft

Attempt identity: ${request.attemptId}
Attempt: ${request.attempt} of 2.
Fresh session: do not assume any prior conversation.
Deadline (Unix ms): ${request.deadline}

## Task
Explain the complete verified change as a pull-request draft. Inspect the diff from the original base, relevant definitions, callers, tests, and configuration only as needed to explain how the requested behavior works.

Stay read-only. Do not modify files, create artifacts, execute the target code, rerun checks, refactor, or review the implementation. The orchestrator creates PR.md and supplies trusted verification results separately.

## Writing rules
- Make the ticket's behavior the focus; do not give an unrelated repository tour.
- Supply a concise title and 1-5 summary bullets covering what changed, why, and material user-visible behavior.
- ELI5 must be 2-4 short sentences explaining what goes in, what changes, and what comes out. Keep simplifications accurate.
- Play-by-play must follow execution order. Each item explains what happens and why it matters in 1-3 short sentences.
- Cite relevant path:line references. Attach errors, side effects, async behavior, and consequential edge cases to the step where they occur.
- Distinguish behavior established by code from inferred intent. Do not invent runtime behavior, benchmark claims, or verification results.
- Do not add advice, ratings, a second review, or a generic conclusion.

## Ticket
Kind: ${request.context.ticket.kind}
${request.context.ticket.markdown}

Criterion IDs and requirements:
${request.context.ticket.criteria.map(({ id, text }) => `- ${id}: ${text}`).join("\n")}

## Verified candidate
Workspace: ${request.workspacePath}
Original base commit: ${request.context.baseCommit}
Verified tree identity: ${request.context.snapshotId}
Inspect the complete tracked change with: git diff ${request.context.baseCommit} --
Also run git status --short and inspect untracked files; the diff alone omits them.

## Supplied skills
${request.context.standards.map((path) => `- ${path}`).join("\n") || "None supplied; follow applicable repository instructions."}

## Predecessor report pointers
${JSON.stringify(request.context.reportReferences, null, 2)}

## Trusted host evidence
These facts were observed by the orchestrator and are bound to recorded tree/suite identities. Artifact paths are read-only sandbox paths.
${JSON.stringify(request.context.evidenceBundles, null, 2)}

## Required completion report
Finish with exactly one JSON object enclosed in pull_request_report tags, without Markdown fences inside the tags.
Allowed status values: "completed" and "blocked". Use "completed" only when the final candidate can be accurately explained from the available source and context.
Do not include trusted verification prose in the report; the orchestrator renders that section from the supplied check records.
<pull_request_report>
${reportExample}
</pull_request_report>
`;
}

export function renderPullRequestMarkdown(
  report: PullRequestReport,
  checks: readonly CheckResult[],
  criteria: readonly StageReport["criteria"][number][],
): string {
  if (report.status !== "completed") {
    throw new Error("Cannot render a blocked pull-request report");
  }

  const lines = [
    `# ${singleLine(report.title)}`,
    "",
    "## Summary",
    "",
    ...report.summary.map((item) => `- ${singleLine(item)}`),
    "",
    "## ELI5",
    "",
    singleLine(report.eli5),
    "",
    "## Play-by-play",
    "",
    ...report.playByPlay.map((item, index) => {
      const references = item.references.length === 0
        ? ""
        : ` (${item.references.map((reference) => `\`${escapeCode(reference)}\``).join(", ")})`;
      return `${index + 1}. ${singleLine(item.explanation)}${references}`;
    }),
    "",
    "## Verification",
    "",
    ...(checks.length === 0
      ? ["- No trusted checks were recorded."]
      : checks.map((check) => {
          const tests = check.discoveredTests === undefined
            ? ""
            : `; ${check.discoveredTests} tests discovered, ${check.skippedTests ?? 0} skipped`;
          return `- \`${escapeCode(check.command)}\` — ${check.exitCode === 0 ? "passed" : `failed with exit code ${check.exitCode}`}${tests}.`;
        })),
    ...(criteria.length === 0
      ? []
      : ["", ...criteria.map((criterion) => `- ${singleLine(criterion.id)}: ${criterion.verdict}.`)]),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function escapeCode(value: string): string {
  return singleLine(value).replaceAll("`", "\\`");
}
