import type { AttemptRequest, Stage } from "./contracts.js";

const RESPONSIBILITY_BY_STAGE: Readonly<Record<Stage, string>> = {
  "test-design": "Create executable black-box acceptance tests and a criterion-to-test rationale. Do not implement production behavior.",
  implementation: "Implement the ticket with test-driven development. Do not modify authoritative acceptance tests.",
  refactor: "Apply repository standards and improve maintainability without changing required behavior. Do not modify authoritative acceptance tests.",
  review: "Review the complete diff against the ticket, fix every substantiated issue, and run focused checks. Do not modify authoritative acceptance tests.",
};

export function buildStagePrompt(request: AttemptRequest): string {
  const priorReports = request.context.priorReports.length === 0
    ? "None"
    : JSON.stringify(request.context.priorReports, null, 2);
  const failures = request.context.failureEvidence.length === 0
    ? "None"
    : request.context.failureEvidence.join("\n");
  const correction = request.correction
    ? "This is the single authorized acceptance-test correction. Change only tests whose behavior conflicts with the original criteria; record every correction."
    : RESPONSIBILITY_BY_STAGE[request.stage];

  return `# Autonomous factory attempt\n\nAttempt identity: ${request.attemptId}\nFresh session: do not assume any prior conversation.\nDeadline (Unix ms): ${request.deadline}\n\n## Responsibility\n${correction}\n\n## Ticket\n${request.context.ticket.markdown}\n\n## Workspace handoff\nWorkspace: ${request.workspacePath}\nCurrent snapshot: ${request.context.diffFromBase}\nAuthoritative suite: ${request.context.acceptanceSuite?.path ?? "not frozen yet"}\n\n## Repository standards\nRead and follow every repository AGENTS.md and each supplied skill before editing:\n${request.context.standards.map((path) => `- ${path}`).join("\n")}\n\n## Prior stage reports\n${priorReports}\n\n## Failure evidence\n${failures}\n\n## Required completion report\nFinish with exactly one <stage_report> JSON object matching this shape:\n{\n  "status": "completed | blocked | suspected-test-defect",\n  "stage": "${request.stage}",\n  "criteria": [{ "id": "criterion id", "verdict": "met | unmet | unverifiable", "evidence": ["artifact or command"] }],\n  "evidence": ["artifact or command"],\n  "changedWork": "concise summary",\n  "unresolvedIssues": []\n}\nAn exit code or prose claim is not acceptance evidence.\n`;
}
