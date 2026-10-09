import type { AttemptRequest, Stage } from "./contracts.js";

const PROCEDURE_BY_STAGE: Readonly<Record<Stage, string>> = {
  "test-design": `Create executable black-box acceptance tests, not production behavior.
1. Read the original criteria and supplied acceptance-suite protocol. Derive distinguishing scenarios and expected values from the contract, not private implementation details.
2. Write only the candidate suite specified by that protocol, including a criterion-to-test mapping and rationale covering every criterion. Do not add production scaffolding or replace the trusted runner.
3. Feature and bug cases must expose the intended missing behavior; refactor cases must preserve baseline GREEN. Invalid setup, compilation failures, and generic placeholder exceptions are not behavioral RED. Distinguish an intentionally absent public contract from a broken harness.
4. Record available baseline observations honestly. The orchestrator validates the candidate against the original baseline. A completed test-design stage may report unmet criteria with intentional RED evidence; do not implement behavior to make them met.`,
  implementation: `Implement the whole ticket using small test-driven increments. Do not modify authoritative acceptance tests or their runner.
1. Read the acceptance mapping, rationale, and prior RED/GREEN evidence. Select the next uncovered criterion and inspect its affected consumers. Reuse established RED; do not break working behavior to manufacture it.
2. Add a focused implementation-level test when needed, run it before the fix, implement the simplest real solution, and rerun the same check. Use existing test infrastructure. Add only the minimum structure needed for the next behavior; no provisional skeleton may remain at completion.
3. Build changed targets and run affected existing tests against newly built code. Fix concrete standards violations while keeping checks green, then continue until every criterion is addressed.
4. Report suspected acceptance-test defects with the disputed case, original criterion, and concrete evidence; never weaken acceptance expectations to fit production code.`,
  refactor: `Apply repository standards without changing required behavior. Do not modify authoritative acceptance tests or their runner.
1. Read the whole change from the original base, the ticket, supplied standards, and prior evidence. Identify concrete maintainability or standards violations.
2. Make only supported behavior-preserving improvements. Do not invent abstractions, redesign unrelated code, or change public contracts. If no concrete violation exists, leave the code unchanged.
3. Build and rerun affected existing checks after edits. A discovered behavioral defect requires a focused failing check and fix, not an unverified refactor. Report changes and updated criterion evidence.`,
  review: `Review the whole branch against the original ticket and fix substantiated issues. Do not modify authoritative acceptance tests or their runner.
1. Inspect the complete change from the original base, affected consumers, acceptance mapping, and observed checks—not merely prior summaries or the latest increment.
2. Make one bounded review for omitted requirements, unsupported dependency assumptions, consequential edge cases, and standards violations. Each finding must name a concrete failure scenario or violated requirement; agreement between code and a self-authored test is not independent contract evidence.
3. Repair supported findings with focused regression checks where applicable, build, and rerun affected checks. Recheck repairs rather than starting another unrestricted review. Report findings and resolutions, or explicitly state that none were found.
4. Give a final verdict for every criterion. Unresolved defects or unverifiable requirements prevent downstream completion.`,
};

const CORRECTION_PROCEDURE = `This is the single authorized acceptance-test correction, not an implementation attempt.
1. Compare each disputed expectation with the original criterion and independent dependency evidence. If no contract-supported correction exists, report blocked with the reason.
2. Read the mounted authoritative suite, but modify only the writable candidate suite specified by the supplied acceptance protocol. Do not change production code, the authoritative mount, or the trusted runner. Preserve unrelated cases and criterion mappings.
3. Record each old expectation, corrected expectation, and supporting requirement in the report. Never weaken tests merely to accommodate the implementation.
4. The orchestrator validates the corrected candidate against the original baseline before continuing. This correction does not reset any stage's recovery budget.`;

export function buildStagePrompt(request: AttemptRequest): string {
  const priorReports = request.context.priorReports.length === 0
    ? "None"
    : JSON.stringify(request.context.priorReports, null, 2);
  const failures = request.context.failureEvidence.length === 0
    ? "None"
    : request.context.failureEvidence.join("\n");
  const reportExample = JSON.stringify({
    status: "blocked",
    stage: request.stage,
    criteria: request.context.ticket.criteria.map(({ id }) => ({
      id,
      verdict: "unverifiable",
      evidence: ["Replace with observed evidence or the precise verification limitation"],
    })),
    evidence: ["Replace with exact commands, observed results, and accessible artifact paths"],
    changedWork: "Replace with actual changes and any review findings or corrections",
    unresolvedIssues: ["Replace with the concrete blocker; use an empty array only when none remain"],
  }, null, 2);

  return `# Autonomous factory attempt

Attempt identity: ${request.attemptId}
Attempt: ${request.attempt} of 2 for normal stages; correction has one authorized attempt.
Fresh session: do not assume any prior conversation.
Deadline (Unix ms): ${request.deadline}

## Operating rules
- Execute only the assigned stage, but complete all of its obligations. Resolve ordinary ambiguity with the smallest repository-consistent decision; record consequential assumptions. Do not wait for phase approval or silently reduce scope.
- Load every supplied skill through OpenCode's native \`skill\` tool before editing, then read its mounted SKILL.md when you need to cite or recheck exact wording. If a supplied skill is absent from the tool, report the attempt blocked instead of proceeding without it. Read applicable repository AGENTS.md files and apply each instruction within its stage and file scope. Use real tool calls, not action-like prose; correct rejected calls rather than repeating malformed text.
- Ground each criterion in its source, observable behavior, distinguishing input/expected result, and evidence. Keep this record compact; no extra planning document is required. Include known boundary and failure behavior from the start.
- Preserve public contracts, security, data integrity, and repository boundaries. Verify consequential dependency APIs and semantics using installed versions, local usages, source, or authoritative documentation; do not guess from similar names.
- Inspect only to resolve the next edit/check or a concrete failure. Record exact commands, exit status, and decisive output. Compilation proves type/structure correctness, not behavioral acceptance; never substitute it for required tests.
- Distinguish expected RED from build, fixture, runtime, or environment failures. Do not suppress diagnostics, weaken checks, or claim unobserved results. A failed build invalidates checks against older artifacts.
- For unexpected failures, use evidence-based repairs and rerun the same check. Do not repeat an unchanged failed approach. If no supported repair remains or execution is unavailable, report the precise blocker and preserve evidence.
- The orchestrator owns trusted gates, fresh-session recovery, and branch publication. Do not launch another factory/controller, reset recovery budgets, publish/merge branches, or treat a successful tool exit as acceptance. Do not invent commands or claim execution of host-only gates; distinguish agent-observed checks from supplied gate evidence.
- Own every process you start: retain its PID or process-group ID and terminate only that identity in structured cleanup. Never use broad name-based termination such as \`pkill\`, \`killall\`, or \`pkill -f\`; it can kill the agent shell or unrelated supervisory processes.

## Assigned procedure
${request.correction ? CORRECTION_PROCEDURE : PROCEDURE_BY_STAGE[request.stage]}

## Ticket
Kind: ${request.context.ticket.kind}
${request.context.ticket.markdown}

Criterion IDs and requirements:
${request.context.ticket.criteria.map(({ id, text }) => `- ${id}: ${text}`).join("\n")}

## Workspace handoff
Workspace: ${request.workspacePath}
Original base commit: ${request.context.baseCommit}
Current snapshot (tree identity, not a diff): ${request.context.snapshotId}
Inspect the complete tracked change with: git diff ${request.context.baseCommit} --
Also run git status --short and inspect untracked files; the diff alone omits them. Never use only the last commit as the review baseline.
Authoritative suite: ${request.context.acceptanceSuite?.path ?? "not frozen yet; follow the supplied candidate-suite protocol"}
Read its manifest for criterion mapping and rationale when present. Supplied skills and the mounted suite are read-only inputs; write only within the workspace and assigned stage scope.

## Supplied skills
${request.context.standards.map((path) => `- ${path}`).join("\n") || "None supplied; follow applicable repository instructions."}

## Prior stage reports
${priorReports}

## Failure evidence
${failures}

## Required completion report
Finish with exactly one JSON object enclosed in stage_report tags as shown below, without Markdown fences inside the tags. The example is a valid blocked-report shape, not evidence to copy.
Allowed status values: "completed", "blocked", "suspected-test-defect".
Allowed criterion verdicts: "met", "unmet", "unverifiable".
Use the exact stage shown and exactly one entry for every original criterion ID. Cite observed commands with results or evidence artifacts; command names and prose success claims alone do not prove acceptance.
"completed" means this stage's work is complete. Test design (including correction) may complete with intentional unmet criteria; downstream stages require all criteria met and no unresolved issues. Use "suspected-test-defect" downstream only with a disputed expectation and contract evidence. Missing checks or unresolved requirements must be reported honestly, never converted into success.
Include consequential decisions, review findings/resolutions, or old/new corrected expectations in changedWork and evidence as applicable. Do not add another report format. No provisional skeleton, fake behavior, or unfinished assigned work may be called completed.
<stage_report>
${reportExample}
</stage_report>
`;
}
