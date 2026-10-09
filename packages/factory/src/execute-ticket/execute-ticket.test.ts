import { describe, expect, it } from "vitest";
import { executeTicket } from "./execute-ticket.js";
import type {
  AttemptOutcome,
  FactoryDependencies,
  RunRequest,
  Stage,
  StageReport,
} from "../contracts.js";

const stages: readonly Stage[] = ["test-design", "implementation", "refactor", "review"];

function completedReport(stage: Stage): StageReport {
  return {
    status: "completed",
    stage,
    criteria: [{ id: "AC-1", verdict: "met", evidence: ["check-1"] }],
    evidence: ["agent-log"],
    changedWork: `${stage} complete`,
    unresolvedIssues: [],
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
    model: { provider: "vllm", modelId: "served-model", endpoint: "http://vllm/v1" },
    attemptTimeoutMs: 1_000,
    standards: ["standards/skill.md"],
  };
}

function dependencies(outcomes: AttemptOutcome[]): FactoryDependencies & { calls: string[] } {
  const calls: string[] = [];
  let outcomeIndex = 0;
  return {
    calls,
    workspace: {
      async prepare() { calls.push("prepare"); return { path: "/run/work", baseCommit: "base", branch: "solution/run-1" }; },
      async snapshot(label) { calls.push(`snapshot:${label}`); return { id: `${label}-tree`, commit: `${label}-commit` }; },
      async publishBranch() { calls.push("publish"); return { branch: "solution/run-1", commit: "final" }; },
      async disposeExecutionResources() { calls.push("dispose"); },
    },
    backend: {
      async runAttempt(attempt) {
        calls.push(`attempt:${attempt.stage}:${attempt.attempt}:${attempt.sessionId}`);
        const result = outcomes[outcomeIndex++];
        if (!result) throw new Error("No configured outcome");
        return result;
      },
      async stopAttempt(attemptId) { calls.push(`stop:${attemptId}`); },
    },
    verification: {
      async preflight() { calls.push("preflight"); return { passed: true, checks: [passedCheck("baseline")] }; },
      async validateCandidate() { calls.push("validate-candidate"); return { accepted: true, passed: true, suiteVersion: "suite-1", mapping: [{ criterionId: "AC-1", tests: ["acceptance"] }], checks: [failedCheck("red")] }; },
      async freezeSuite() { calls.push("freeze"); return { version: "suite-1", digest: "digest", path: "/trusted/suite-1" }; },
      async runChecks(stage) { calls.push(`checks:${stage}`); return { passed: true, checks: [passedCheck(stage)] }; },
      async captureProductionIdentity() { calls.push("capture-production"); return "production-before-correction"; },
      async validateCorrection(_request, _workspace, _report, _current, identity) { calls.push(`correct:${identity}`); return { accepted: true, passed: true, suiteVersion: "suite-2", mapping: [{ criterionId: "AC-1", tests: ["acceptance"] }], checks: [failedCheck("corrected-red")] }; },
      async integrateSuite() { calls.push("integrate-suite"); },
      async verifyPublished() { calls.push("verify-published"); return { passed: true, checks: [{ ...passedCheck("published"), treeId: "final-candidate-tree" }] }; },
    },
    artifacts: {
      async record(event) { calls.push(`record:${event.type}`); },
      async attach() { return "artifact"; },
      async finalize(outcome) { calls.push(`finalize:${outcome.status}`); return "/runs/run-1/report.json"; },
    },
  };
}

function outcome(stage: Stage, report = completedReport(stage)): AttemptOutcome {
  return { status: "completed", attemptId: `${stage}-attempt`, sessionId: `${stage}-session`, report, evidence: ["agent-log"] };
}

function passedCheck(command: string) {
  return { command, exitCode: 0, discoveredTests: 1, skippedTests: 0, outputArtifact: "out", treeId: "tree" };
}
function failedCheck(command: string) {
  return { command, exitCode: 1, discoveredTests: 1, skippedTests: 0, outputArtifact: "out", treeId: "tree" };
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
    ]);
    expect(deps.calls.indexOf("verify-published")).toBeLessThan(deps.calls.indexOf("publish"));
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

  it("stops after exactly two failed attempts and never starts later stages", async () => {
    const failure = (id: string): AttemptOutcome => ({ status: "timeout", attemptId: id, sessionId: id, evidence: [id], error: "deadline" });
    const deps = dependencies([outcome("test-design"), failure("impl-1"), failure("impl-2")]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
    expect(result.terminalReason).toContain("implementation");
    expect(deps.calls.some((call) => call.includes("refactor"))).toBe(false);
    expect(deps.calls.filter((call) => call.startsWith("attempt:implementation"))).toHaveLength(2);
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
    const correctionReport = completedReport("test-design");
    const deps = dependencies([
      outcome("test-design"), outcome("implementation", defectReport), outcome("test-design", correctionReport),
      outcome("implementation"), outcome("refactor"), outcome("review"),
    ]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("succeeded");
    expect(deps.calls.filter((call) => call === "correct:production-before-correction")).toHaveLength(1);
    expect(deps.calls).toContain("attempt:implementation:2:run-1-implementation-2");
  });

  it("rejects a defect report on an exhausted attempt without a correction invocation", async () => {
    const defectReport: StageReport = { ...completedReport("implementation"), status: "suspected-test-defect" };
    const firstFailure: AttemptOutcome = { status: "execution-failure", attemptId: "impl-1", sessionId: "one", error: "bad", evidence: [] };
    const deps = dependencies([outcome("test-design"), firstFailure, outcome("implementation", defectReport)]);

    const result = await executeTicket(request(), deps);

    expect(result.status).toBe("failed");
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
});
