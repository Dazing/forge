import { describe, expect, it, vi } from "vitest";
import { executeTicket } from "./execute-ticket.js";
import type {
  ArtifactEvent,
  CorrectionBoundaryDiagnostics,
  AttemptRequest,
  AttemptOutcome,
  FactoryDependencies,
  RunRequest,
  Stage,
  StageReport,
} from "../contracts.js";

const stages: readonly Stage[] = ["test-design", "implementation", "refactor", "review"];

function completedReport(stage: Stage): StageReport {
  const common = {
    status: "completed" as const,
    criteria: [{ id: "AC-1", verdict: "met" as const, evidence: ["check-1"] }],
    evidence: ["agent-log"],
    unresolvedIssues: [] as string[],
  };
  if (stage === "test-design" || stage === "implementation") {
    return {
      kind: "authoring",
      ...common,
      stage,
      operation: stage,
      changedWork: `${stage} complete`,
    };
  }
  if (stage === "refactor") {
    return {
      kind: "refactor",
      ...common,
      stage,
      operation: stage,
      outcome: "no-op",
      findings: [],
      changedWork: "No supported refactor needed.",
    };
  }
  return {
    kind: "review",
    ...common,
    stage,
    operation: stage,
    contractCompliance: "approved",
    implementationQuality: "approved",
    verdict: "approved",
    findings: [],
  };
}

function request(): RunRequest {
  return {
    runId: "run-1",
    ticket: {
      path: "ticket.md",
      markdown: "# Ticket\n## Acceptance criteria\n- AC-1: works",
      digest: "ticket-digest",
      kind: "feature",
      criteria: [{ id: "AC-1", text: "works" }],
    },
    repository: {
      sourcePath: "/source",
      baseRef: "main",
      outputBranch: "solution/run-1",
      profilePath: "profile.json",
    },
    model: { provider: "openai-subscription", modelId: "gpt-6-luna" },
    attemptTimeoutMs: 1_000,
    skills: {
      shared: ["standards/skill.md"],
      byRole: {
        "test-design": [], implementation: [], refactor: [], review: [],
        "acceptance-correction": [], repair: [], "re-review": [], "pull-request": [],
      },
    },
  };
}

function dependencies(
  outcomes: AttemptOutcome[],
  snapshot?: (label: string) => Promise<{ id: string; commit?: string }>,
): FactoryDependencies & { calls: string[]; requests: AttemptRequest[] } {
  const calls: string[] = [];
  const requests: AttemptRequest[] = [];
  let outcomeIndex = 0;
  return {
    calls,
    requests,
    workspace: {
      async prepare() { calls.push("prepare"); return { path: "/run/work", baseCommit: "base", branch: "solution/run-1" }; },
      async snapshot(label) {
        calls.push(`snapshot:${label}`);
        return snapshot?.(label) ?? { id: "tree", commit: `${label}-commit` };
      },
      async createAnalysisWorkspace(expectedTreeId) {
        calls.push(`analysis:create:${expectedTreeId}`);
        return { path: "/run/analysis", treeId: expectedTreeId };
      },
      async createChangePackage(fromTreeId, toTreeId) {
        calls.push(`change-package:${fromTreeId}:${toTreeId}`);
        return JSON.stringify({ fromTreeId, toTreeId });
      },
      async verifyAnalysisWorkspace() { calls.push("analysis:verify"); },
      async disposeAnalysisWorkspace() { calls.push("analysis:dispose"); },
      async publishBranch() { calls.push("publish"); return { branch: "solution/run-1", commit: "final" }; },
      async disposeExecutionResources() { calls.push("dispose"); },
    },
    backend: {
      async runAttempt(attempt) {
        requests.push(attempt);
        calls.push(`attempt:${attempt.stage}:${attempt.attempt}:${attempt.sessionId}`);
        const result = outcomes[outcomeIndex++];
        if (!result) throw new Error("No configured outcome");
        return result;
      },
      async runPullRequestAttempt(attempt) {
        calls.push(`attempt:pull-request:${attempt.attempt}:${attempt.sessionId}`);
        return {
          status: "completed" as const,
          attemptId: attempt.attemptId,
          sessionId: attempt.sessionId,
          report: pullRequestReport(),
          evidence: ["pull-request-transcript"],
        };
      },
      async stopAttempt(attemptId) { calls.push(`stop:${attemptId}`); },
    },
    verification: {
      async preflight() { calls.push("preflight"); return { passed: true, checks: [passedCheck("baseline")] }; },
      async validateCandidate() { calls.push("validate-candidate"); return { accepted: true, passed: true, suiteVersion: "suite-1", mapping: [{ criterionId: "AC-1", tests: ["acceptance"] }], checks: [failedCheck("red")] }; },
      async freezeSuite() { calls.push("freeze"); return { version: "suite-1", digest: "digest", path: "/trusted/suite-1" }; },
      async runChecks(stage) { calls.push(`checks:${stage}`); return { passed: true, checks: [passedCheck(stage)] }; },
      async captureProtectedContentIdentity() { calls.push("capture-protected"); return { digest: "protected-before-correction", files: [] }; },
      async validateCorrection(_request, _workspace, _report, _current, identity) { calls.push(`correct:${identity.digest}`); return { accepted: true, passed: true, suiteVersion: "suite-2", mapping: [{ criterionId: "AC-1", tests: ["acceptance"] }], checks: [failedCheck("corrected-red")] }; },
      async integrateSuite() { calls.push("integrate-suite"); },
      async verifyFinalCandidate() { calls.push("verify-final-candidate"); return { passed: true, checks: [{ ...passedCheck("published"), treeId: "final-candidate-tree" }] }; },
    },
    artifacts: {
      async record(event) { calls.push(`record:${event.type}`); },
      async attach(name) { calls.push(`attach:${name}`); return `/runs/run-1/artifacts/${name}`; },
      async finalize(outcome) { calls.push(`finalize:${outcome.status}`); return "/runs/run-1/report.json"; },
    },
  };
}

function outcome(stage: Stage, report = completedReport(stage)): AttemptOutcome {
  return { status: "completed", attemptId: `${stage}-attempt`, sessionId: `${stage}-session`, report, evidence: ["agent-log"] };
}
function correctionReport(): StageReport {
  const report = completedReport("test-design");
  if (report.kind !== "authoring") throw new Error("Expected authoring report");
  return { ...report, operation: "acceptance-correction" };
}

function pullRequestReport() {
  return {
    status: "completed" as const,
    title: "Add requested behavior",
    summary: ["Implements the ticket."],
    eli5: "The service now handles the requested input and returns the expected result.",
    playByPlay: [{
      explanation: "The entry point delegates to the new behavior.",
      references: ["src/service.ts:10"],
    }],
    evidence: ["Inspected the verified candidate."],
    unresolvedIssues: [],
  };
}


function passedCheck(command: string) {
  return { command, exitCode: 0, discoveredTests: 1, skippedTests: 0, outputArtifact: "/dev/null", treeId: "tree" };
}
function failedCheck(command: string) {
  return { command, exitCode: 1, discoveredTests: 1, skippedTests: 0, outputArtifact: "/dev/null", treeId: "tree" };
}

describe("executeTicket", () => {
  it("publishes only after all fresh stages and exact published content pass trusted gates", async () => {
    const deps = dependencies(stages.map((stage) => outcome(stage)));
    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("succeeded");
    expect(result.finalCommit).toBe("final");
    expect(deps.calls.filter((call) => call.startsWith("attempt:"))).toEqual([
      "attempt:test-design:1:run-1-test-design-1",
      "attempt:implementation:1:run-1-implementation-1",
      "attempt:refactor:1:run-1-refactor-1",
      "attempt:review:1:run-1-review-1",
      "attempt:pull-request:1:run-1-pull-request-1",
    ]);
    expect(deps.calls.indexOf("verify-final-candidate")).toBeLessThan(deps.calls.indexOf("publish"));
  });

  it("rejects an approval when the candidate identity changes after review", async () => {
    const deps = dependencies(stages.map((stage) => outcome(stage)), async (label) => ({
      id: label === "review-before-1" ? "reviewed-tree" : label === "approved-candidate" ? "changed-tree" : "base-tree",
    }));

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReason).toContain("approved review for the current candidate identity");
    expect(deps.calls).not.toContain("publish");
  });

  it("records durable boundaries around every workspace snapshot", async () => {
    const deps = dependencies(stages.map((stage) => outcome(stage)));

    await executeTicket(request(), deps);

    expect(deps.calls.filter((call) => call.startsWith("record:workspace-snapshot-"))).toEqual([
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-finished",
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-finished",
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-finished",
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-finished",
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-finished",
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-finished",
    ]);
  });

  it("fails with a durable report when a between-stage snapshot stops responding", async () => {
    let snapshots = 0;
    const deps = dependencies(stages.map((stage) => outcome(stage)), async (label) => {
      snapshots += 1;
      if (snapshots === 2) return new Promise<never>(() => undefined);
      return { id: `${label}-tree` };
    });
    const result = await executeTicket({ ...request(), orchestrationTimeoutMs: 10 }, deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReason).toMatch(/workspace snapshot/i);
    expect(deps.calls).toContain("record:workspace-snapshot-started");
    expect(deps.calls).toContain("finalize:failed");
    expect(deps.calls.some((call) => call.startsWith("attempt:refactor"))).toBe(false);
  });

  it("stops a failed attempt before one fresh recovery and preserves stage order", async () => {
    const failure: AttemptOutcome = { status: "execution-failure", attemptId: "impl-1", sessionId: "first", evidence: ["failure"], error: "injected" };
    const deps = dependencies([
      outcome("test-design"), failure, outcome("implementation"), outcome("refactor"), outcome("review"),
    ]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("succeeded");
    expect(deps.calls).toContain("stop:impl-1");
    expect(deps.calls.indexOf("stop:impl-1")).toBeLessThan(deps.calls.indexOf("attempt:implementation:2:run-1-implementation-2"));
  });

  it("carries complete failed gate evidence into the fresh retry", async () => {
    const deps = dependencies([
      outcome("test-design"), outcome("implementation"), outcome("implementation"),
      outcome("refactor"), outcome("review"),
    ]);
    let implementationChecks = 0;
    const originalRunChecks = deps.verification.runChecks.bind(deps.verification);
    Object.assign(deps.verification, {
      async runChecks(stage: Stage, workspace: Parameters<typeof originalRunChecks>[1], suite: Parameters<typeof originalRunChecks>[2]) {
        if (stage === "implementation" && implementationChecks++ === 0) {
          deps.calls.push("checks:implementation");
          return { passed: false, checks: [failedCheck("failed-implementation")] };
        }
        return originalRunChecks(stage, workspace, suite);
      },
    });

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("succeeded");
    const retry = deps.requests.find(({ operation, attempt }) => operation === "implementation" && attempt === 2);
    expect(retry?.context.evidenceBundles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provenance: "host-observed",
        checks: [expect.objectContaining({
          command: "failed-implementation",
          exitCode: 1,
          outputArtifact: expect.objectContaining({ mediaType: "text/plain" }),
        })],
      }),
    ]));
  });

  it("stops after exactly two failed attempts and never starts later stages", async () => {
    const failure = (id: string): AttemptOutcome => ({ status: "timeout", attemptId: id, sessionId: id, evidence: [id], error: "deadline" });
    const deps = dependencies([outcome("test-design"), failure("impl-1"), failure("impl-2")]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReason).toContain("implementation");
    expect(deps.calls.some((call) => call.includes("refactor"))).toBe(false);
    expect(deps.calls.filter((call) => call.startsWith("attempt:implementation"))).toHaveLength(2);
  });

  it("makes unconfirmed runner shutdown terminal without starting recovery", async () => {
    const stalled: AttemptOutcome = {
      status: "shutdown-stalled",
      attemptId: "test-design-stalled",
      sessionId: "stalled-session",
      error: "runner ignored abort",
      evidence: ["stalled-transcript"],
    };
    const deps = dependencies([stalled]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReason).toContain("did not stop");
    expect(deps.calls.filter((call) => call.startsWith("attempt:test-design"))).toHaveLength(1);
    expect(deps.calls.some((call) => call.startsWith("attempt:implementation"))).toBe(false);
    expect(deps.calls).not.toContain("stop:test-design-stalled");
  });

  it("counts a malformed completed report as a failed attempt", async () => {
    const malformed = { status: "completed", attemptId: "bad", sessionId: "bad", report: { nope: true }, evidence: [] } as unknown as AttemptOutcome;
    const deps = dependencies([outcome("test-design"), malformed, outcome("implementation"), outcome("refactor"), outcome("review")]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("succeeded");
    expect(deps.calls).toContain("stop:bad");
    expect(deps.calls).toContain("attempt:implementation:2:run-1-implementation-2");
  });

  it("allows one correction then uses the reporting stage remaining attempt without resetting its budget", async () => {
    const defectReport: StageReport = { ...completedReport("implementation"), status: "suspected-test-defect" };
    const correction = correctionReport();
    const deps = dependencies([
      outcome("test-design"), outcome("implementation", defectReport), outcome("test-design", correction),
      outcome("implementation"), outcome("refactor"), outcome("review"),
    ]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("succeeded");
    expect(deps.calls.filter((call) => call === "correct:protected-before-correction")).toHaveLength(1);
    expect(deps.calls).toContain("attempt:implementation:2:run-1-implementation-2");
  });

  it("does not grant another correction to a later stage after the single correction was consumed", async () => {
    const deps = dependencies([
      outcome("test-design"),
      outcome("implementation", { ...completedReport("implementation"), status: "suspected-test-defect" }),
      outcome("test-design", correctionReport()),
      outcome("implementation"),
      outcome("refactor", { ...completedReport("refactor"), status: "suspected-test-defect" }),
    ]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReasonCode).toBe("correction-budget-unavailable");
    expect(deps.calls.filter((call) => call.startsWith("correct:"))).toHaveLength(1);
    expect(deps.calls.filter((call) => call.startsWith("attempt:refactor:"))).toHaveLength(1);
    expect(deps.calls).not.toContain("publish");
  });

  it("terminates at the first reporting-stage attempt with boundary diagnostics and never publishes", async () => {
    const defectReport: StageReport = { ...completedReport("implementation"), status: "suspected-test-defect" };
    const deps = dependencies([outcome("test-design"), outcome("implementation", defectReport), outcome("test-design", correctionReport())]);
    const diagnostics: CorrectionBoundaryDiagnostics = {
      policy: "protected-workspace-content",
      exclusions: [".git", ".factory/acceptance", ".factory/verification-runtime"],
      beforeIdentity: "protected-before-correction",
      afterIdentity: "protected-after-correction",
      added: [".factory/probe/helper.mjs"],
      modified: [],
      deleted: [],
      binding: { runId: "run-1", ticketDigest: "ticket-digest", baseCommit: "base", suiteVersion: "suite-1", suiteDigest: "digest" },
    };
    const reason = "Acceptance correction violated protected workspace content: added .factory/probe/helper.mjs";
    deps.verification.validateCorrection = async () => ({
      accepted: false, passed: false, checks: [], reason, reasonCode: "correction-boundary-violation", diagnostics,
    });
    const events: ArtifactEvent[] = [];
    deps.artifacts.record = async (event) => { events.push(event); };

    const result = await executeTicket(request(), deps);

    expect(result).toMatchObject({ status: "failed", terminalReason: reason, terminalReasonCode: "correction-boundary-violation" });
    expect(deps.calls.filter((call) => call.startsWith("attempt:implementation:"))).toHaveLength(1);
    expect(deps.calls.filter((call) => call === "freeze")).toHaveLength(1);
    expect(deps.calls).not.toContain("publish");
    expect(deps.calls).not.toContain("integrate-suite");
    expect(events.find((event) => event.type === "gate-finished" && event.operationId === "acceptance-correction")?.details)
      .toMatchObject({ checks: [], reason, reasonCode: "correction-boundary-violation", diagnostics });
    expect(events.find((event) => event.type === "stage-finished" && event.stage === "implementation")?.details)
      .toMatchObject({ accepted: false, reason, reasonCode: "correction-boundary-violation" });
    expect(events.find((event) => event.type === "run-finished")?.details)
      .toMatchObject({ reason, reasonCode: "correction-boundary-violation" });
    expect(JSON.stringify(events)).not.toContain("exhausted");
  });

  it.each(["execution-failure", "timeout"] as const)("reports correction %s without claiming normal attempt exhaustion", async (status) => {
    const defectReport: StageReport = { ...completedReport("implementation"), status: "suspected-test-defect" };
    const deps = dependencies([
      outcome("test-design"),
      outcome("implementation", defectReport),
      { status, attemptId: "correction", sessionId: "correction", error: "correction runner failed", evidence: [] },
    ]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReasonCode).toBe("correction-execution-failed");
    expect(result.terminalReason).toContain(status);
    expect(result.terminalReason).toContain("correction runner failed");
    expect(result.terminalReason).not.toContain("exhausted");
    expect(deps.calls.filter((call) => call.startsWith("attempt:implementation:"))).toHaveLength(1);
    expect(deps.calls).not.toContain("publish");
  });

  it("reports a rejected correction report without spending the normal remaining attempt", async () => {
    const defectReport: StageReport = { ...completedReport("implementation"), status: "suspected-test-defect" };
    const deps = dependencies([outcome("test-design"), outcome("implementation", defectReport), outcome("review")]);

    const result = await executeTicket(request(), deps);

    expect(result.terminalReasonCode).toBe("correction-rejected");
    expect(result.terminalReason).not.toContain("exhausted");
    expect(deps.calls.filter((call) => call.startsWith("attempt:implementation:"))).toHaveLength(1);
    expect(deps.calls).not.toContain("publish");
  });

  it("rejects a defect report on an exhausted attempt without a correction invocation", async () => {
    const defectReport: StageReport = { ...completedReport("implementation"), status: "suspected-test-defect" };
    const firstFailure: AttemptOutcome = { status: "execution-failure", attemptId: "impl-1", sessionId: "one", error: "bad", evidence: [] };
    const deps = dependencies([outcome("test-design"), firstFailure, outcome("implementation", defectReport)]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReasonCode).toBe("correction-budget-unavailable");
    expect(result.terminalReason).toContain("correction budget unavailable");
    expect(result.terminalReason).not.toContain("exhausted");
    expect(deps.calls).not.toContain("correct");
  });

  it("treats backend cancellation as terminal without a recovery attempt", async () => {
    const cancelled: AttemptOutcome = {
      status: "cancelled",
      attemptId: "impl-cancelled",
      sessionId: "cancelled-session",
      error: "operator cancellation",
      evidence: ["cancelled-log"],
    };
    const deps = dependencies([outcome("test-design"), cancelled]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("cancelled");
    expect(deps.calls.filter((call) => call.startsWith("attempt:implementation"))).toHaveLength(1);
    expect(deps.calls.some((call) => call.includes("refactor"))).toBe(false);
  });
  it("routes refactor behavioral findings through repair before the broad review", async () => {
    const refactor: StageReport = {
      kind: "refactor", status: "completed", stage: "refactor", operation: "refactor",
      criteria: [{ id: "AC-1", verdict: "unmet", evidence: ["behavioral defect"] }],
      evidence: ["behavioral defect"], unresolvedIssues: ["AC-1"], outcome: "no-op",
      changedWork: "No refactor edit; reported behavioral defect.",
      findings: [{
        localKey: "refactor-defect", category: "correctness", severity: "blocking", criterionId: "AC-1",
        scenario: "Existing behavior violates AC-1.", evidenceReferences: ["probe.log"],
      }],
    };
    const repair: StageReport = {
      kind: "repair", status: "completed", stage: "implementation", operation: "repair",
      criteria: [{ id: "AC-1", verdict: "met", evidence: ["fixed"] }], evidence: ["fixed"],
      unresolvedIssues: [], claims: [{ findingId: "F-0001", claim: "addressed", evidence: ["fixed"] }],
      changedWork: "Fixed the authorized defect.",
    };
    const reReview: StageReport = {
      kind: "re-review", status: "completed", stage: "review", operation: "re-review",
      criteria: [{ id: "AC-1", verdict: "met", evidence: ["verified"] }], evidence: ["verified"],
      unresolvedIssues: [], verdict: "approved",
      findingVerdicts: [{ findingId: "F-0001", verdict: "resolved", evidence: ["verified"] }],
      newFindings: [],
    };
    const deps = dependencies([
      outcome("test-design"), outcome("implementation"), outcome("refactor", refactor),
      outcome("implementation", repair), outcome("review", reReview), outcome("review"),
    ]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("succeeded");
    expect(result.attempts.map(({ stage }) => stage)).toEqual([
      "test-design", "implementation", "refactor", "repair", "re-review", "review", "pull-request",
    ]);
  });

  it("routes blocking review findings through authorized repair and independent re-review", async () => {
    const review: StageReport = {
      kind: "review", status: "completed", stage: "review", operation: "review",
      criteria: [{ id: "AC-1", verdict: "unmet", evidence: ["probe failed"] }],
      evidence: ["probe failed"], unresolvedIssues: ["AC-1 is not met"],
      contractCompliance: "changes-required", implementationQuality: "changes-required",
      verdict: "changes-required",
      findings: [{
        localKey: "missing-behavior", category: "correctness", severity: "blocking",
        criterionId: "AC-1", scenario: "Required input returns the wrong result.",
        evidenceReferences: ["probe.log"], expected: "expected", observed: "actual",
      }],
    };
    const repair: StageReport = {
      kind: "repair", status: "completed", stage: "implementation", operation: "repair",
      criteria: [{ id: "AC-1", verdict: "met", evidence: ["focused regression passed"] }],
      evidence: ["focused regression passed"], unresolvedIssues: [],
      claims: [{ findingId: "F-0001", claim: "addressed", evidence: ["focused regression passed"] }],
      changedWork: "Corrected the authorized behavior.",
    };
    const reReview: StageReport = {
      kind: "re-review", status: "completed", stage: "review", operation: "re-review",
      criteria: [{ id: "AC-1", verdict: "met", evidence: ["repair verified"] }],
      evidence: ["repair verified"], unresolvedIssues: [], verdict: "approved",
      findingVerdicts: [{ findingId: "F-0001", verdict: "resolved", evidence: ["repair verified"] }],
      newFindings: [],
    };
    const deps = dependencies([
      outcome("test-design"), outcome("implementation"), outcome("refactor"),
      outcome("review", review), outcome("implementation", repair), outcome("review", reReview),
    ]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("succeeded");
    expect(result.attempts.map(({ stage }) => stage)).toEqual([
      "test-design", "implementation", "refactor", "review", "repair", "re-review", "pull-request",
    ]);
    expect(deps.calls.filter((call) => call.startsWith("analysis:create:"))).toHaveLength(3);
    expect(result.repairRoundsUsed).toBe(1);
    expect(result.findings).toMatchObject([{ id: "F-0001", lifecycle: "verified-resolved" }]);
  });

  it("keeps repair claims open and stops after the shared two-round re-review budget", async () => {
    const review: StageReport = {
      kind: "review", status: "completed", stage: "review", operation: "review",
      criteria: [{ id: "AC-1", verdict: "unmet", evidence: ["wrong result"] }],
      evidence: ["wrong result"], unresolvedIssues: ["AC-1"], contractCompliance: "changes-required",
      implementationQuality: "changes-required", verdict: "changes-required",
      findings: [{
        localKey: "wrong-result", category: "correctness", severity: "blocking", criterionId: "AC-1",
        scenario: "The required input returns the wrong result.", evidenceReferences: ["review.log"],
        expected: "expected", observed: "actual",
      }],
    };
    const repair = (): StageReport => ({
      kind: "repair", status: "completed", stage: "implementation", operation: "repair",
      criteria: [{ id: "AC-1", verdict: "met", evidence: ["repair claim"] }],
      evidence: ["repair claim"], unresolvedIssues: [],
      claims: [{ findingId: "F-0001", claim: "addressed", evidence: ["repair claim"] }],
      changedWork: "Attempted the authorized repair.",
    });
    const unresolved = (): StageReport => ({
      kind: "re-review", status: "completed", stage: "review", operation: "re-review",
      criteria: [{ id: "AC-1", verdict: "unmet", evidence: ["still wrong"] }],
      evidence: ["still wrong"], unresolvedIssues: ["F-0001 remains"], verdict: "changes-required",
      findingVerdicts: [{ findingId: "F-0001", verdict: "unresolved", evidence: ["still wrong"] }],
      newFindings: [],
    });
    const deps = dependencies([
      outcome("test-design"), outcome("implementation"), outcome("refactor"),
      outcome("review", review), outcome("implementation", repair()), outcome("review", unresolved()),
      outcome("implementation", repair()), outcome("review", unresolved()),
    ]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReason).toContain("two-round defect-repair budget exhausted");
    expect(result.repairRoundsUsed).toBe(2);
    expect(result.findings).toMatchObject([{ id: "F-0001", lifecycle: "open" }]);
    expect(deps.calls).not.toContain("publish");
  });

  it("rejects repair-induced trusted-check regressions before re-review", async () => {
    const review: StageReport = {
      kind: "review", status: "completed", stage: "review", operation: "review",
      criteria: [{ id: "AC-1", verdict: "unmet", evidence: ["wrong result"] }],
      evidence: ["wrong result"], unresolvedIssues: ["AC-1"], contractCompliance: "changes-required",
      implementationQuality: "changes-required", verdict: "changes-required",
      findings: [{
        localKey: "wrong-result", category: "correctness", severity: "blocking", criterionId: "AC-1",
        scenario: "The required input returns the wrong result.", evidenceReferences: ["review.log"],
      }],
    };
    const repair: StageReport = {
      kind: "repair", status: "completed", stage: "implementation", operation: "repair",
      criteria: [{ id: "AC-1", verdict: "met", evidence: ["repair claim"] }],
      evidence: ["repair claim"], unresolvedIssues: [],
      claims: [{ findingId: "F-0001", claim: "addressed", evidence: ["repair claim"] }],
      changedWork: "Attempted the authorized repair.",
    };
    const deps = dependencies([
      outcome("test-design"), outcome("implementation"), outcome("refactor"), outcome("review", review),
      outcome("implementation", repair), outcome("implementation", repair),
    ]);
    const originalRunChecks = deps.verification.runChecks.bind(deps.verification);
    Object.assign(deps.verification, {
      async runChecks(stage: Stage, workspace: Parameters<typeof originalRunChecks>[1], suite: Parameters<typeof originalRunChecks>[2]) {
        if (deps.calls.filter((call) => call === "checks:implementation").length >= 1 && stage === "implementation") {
          deps.calls.push("checks:implementation");
          return { passed: false, checks: [failedCheck("repair-regression")] };
        }
        return originalRunChecks(stage, workspace, suite);
      },
    });

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReason).toContain("Repair round 1 exhausted");
    expect(result.attempts.filter(({ stage }) => stage === "re-review")).toHaveLength(0);
    expect(result.findings).toMatchObject([{ id: "F-0001", lifecycle: "repair-claimed" }]);
    expect(deps.calls).not.toContain("publish");
  });

  it("drafts a pull-request artifact from an isolated copy of the verified candidate before publication", async () => {
    const deps = dependencies(stages.map((stage) => outcome(stage)));
    Object.assign(deps.workspace, {
      async createAnalysisWorkspace(expectedTreeId: string) {
        deps.calls.push(`analysis:create:${expectedTreeId}`);
        return { path: "/run/analysis", treeId: expectedTreeId };
      },
      async disposeAnalysisWorkspace() {
        deps.calls.push("analysis:dispose");
      },
    });
    Object.assign(deps.backend, {
      async runPullRequestAttempt() {
        deps.calls.push("attempt:pull-request:1:run-1-pull-request-1");
        return {
          status: "completed",
          attemptId: "run-1-pull-request-1",
          sessionId: "run-1-pull-request-1",
          report: {
            status: "completed",
            title: "Add requested behavior",
            summary: ["Implements the ticket."],
            eli5: "The service now handles the requested input and returns the expected result.",
            playByPlay: [{
              explanation: "The entry point delegates to the new behavior.",
              references: ["src/service.ts:10"],
            }],
            evidence: ["Inspected the verified candidate."],
            unresolvedIssues: [],
          },
          evidence: ["pull-request-transcript"],
        };
      },
    });

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("succeeded");
    expect(result.pullRequestPath).toBe("/runs/run-1/artifacts/PR.md");
    expect(deps.calls.indexOf("verify-final-candidate")).toBeLessThan(
      deps.calls.indexOf("attempt:pull-request:1:run-1-pull-request-1"),
    );
    expect(deps.calls.indexOf("analysis:dispose")).toBeLessThan(deps.calls.indexOf("attach:PR.md"));
    expect(deps.calls.indexOf("attach:PR.md")).toBeLessThan(deps.calls.indexOf("publish"));
  });
  it("uses one fresh pull-request recovery attempt and discards each analysis workspace", async () => {
    const deps = dependencies(stages.map((stage) => outcome(stage)));
    let invocation = 0;
    Object.assign(deps.backend, {
      async runPullRequestAttempt(attempt: { attempt: number; attemptId: string; sessionId: string }) {
        deps.calls.push(`attempt:pull-request:${attempt.attempt}:${attempt.sessionId}`);
        invocation += 1;
        if (invocation === 1) {
          return {
            status: "execution-failure" as const,
            attemptId: attempt.attemptId,
            sessionId: attempt.sessionId,
            error: "malformed draft",
            evidence: ["first-transcript"],
          };
        }
        return {
          status: "completed" as const,
          attemptId: attempt.attemptId,
          sessionId: attempt.sessionId,
          report: pullRequestReport(),
          evidence: ["second-transcript"],
        };
      },
    });

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("succeeded");
    expect(deps.calls.filter((call) => call.startsWith("analysis:create:"))).toHaveLength(3);
    expect(deps.calls.filter((call) => call === "analysis:dispose")).toHaveLength(3);
    expect(deps.calls).toContain("attempt:pull-request:2:run-1-pull-request-2");
  });

  it("does not publish when both pull-request attempts fail", async () => {
    const deps = dependencies(stages.map((stage) => outcome(stage)));
    Object.assign(deps.backend, {
      async runPullRequestAttempt(attempt: { attempt: number; attemptId: string; sessionId: string }) {
        deps.calls.push(`attempt:pull-request:${attempt.attempt}:${attempt.sessionId}`);
        return {
          status: "execution-failure" as const,
          attemptId: attempt.attemptId,
          sessionId: attempt.sessionId,
          error: "draft unavailable",
          evidence: ["pull-request-transcript"],
        };
      },
    });

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReason).toContain("Pull-request");
    expect(deps.calls.filter((call) => call.startsWith("attempt:pull-request"))).toHaveLength(2);
    expect(deps.calls).not.toContain("publish");
    expect(deps.calls).not.toContain("attach:PR.md");
  });

});
