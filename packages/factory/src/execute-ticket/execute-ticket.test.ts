import { describe, expect, it, vi } from "vitest";
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

function dependencies(
  outcomes: AttemptOutcome[],
  snapshot?: (label: string) => Promise<{ id: string; commit?: string }>,
): FactoryDependencies & { calls: string[] } {
  const calls: string[] = [];
  let outcomeIndex = 0;
  return {
    calls,
    workspace: {
      async prepare() { calls.push("prepare"); return { path: "/run/work", baseCommit: "base", branch: "solution/run-1" }; },
      async snapshot(label) {
        calls.push(`snapshot:${label}`);
        return snapshot?.(label) ?? { id: `${label}-tree`, commit: `${label}-commit` };
      },
      async createAnalysisWorkspace(expectedTreeId) {
        calls.push(`analysis:create:${expectedTreeId}`);
        return { path: "/run/analysis", treeId: expectedTreeId };
      },
      async disposeAnalysisWorkspace() { calls.push("analysis:dispose"); },
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
      async captureProductionIdentity() { calls.push("capture-production"); return "production-before-correction"; },
      async validateCorrection(_request, _workspace, _report, _current, identity) { calls.push(`correct:${identity}`); return { accepted: true, passed: true, suiteVersion: "suite-2", mapping: [{ criterionId: "AC-1", tests: ["acceptance"] }], checks: [failedCheck("corrected-red")] }; },
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
      "attempt:pull-request:1:run-1-pull-request-1",
    ]);
    expect(deps.calls.indexOf("verify-final-candidate")).toBeLessThan(deps.calls.indexOf("publish"));
  });

  it("records durable boundaries around every workspace snapshot", async () => {
    const deps = dependencies(stages.map((stage) => outcome(stage)));

    await executeTicket(request(), deps);

    expect(deps.calls.filter((call) => call.startsWith("record:workspace-snapshot-"))).toEqual([
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-completed",
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-completed",
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-completed",
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-completed",
      "record:workspace-snapshot-started",
      "record:workspace-snapshot-completed",
    ]);
  });

  it("fails with a durable report when a between-stage snapshot stops responding", async () => {
    vi.useFakeTimers();
    let snapshots = 0;
    const deps = dependencies(stages.map((stage) => outcome(stage)), async (label) => {
      snapshots += 1;
      if (snapshots === 2) return new Promise<never>(() => undefined);
      return { id: `${label}-tree` };
    });
    const run = executeTicket({ ...request(), orchestrationTimeoutMs: 25 }, deps);

    await vi.advanceTimersByTimeAsync(25);
    const result = await run;
    vi.useRealTimers();

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
      deps.calls.indexOf("analysis:create:final-candidate-tree"),
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
    expect(deps.calls.filter((call) => call.startsWith("analysis:create:"))).toHaveLength(2);
    expect(deps.calls.filter((call) => call === "analysis:dispose")).toHaveLength(2);
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
