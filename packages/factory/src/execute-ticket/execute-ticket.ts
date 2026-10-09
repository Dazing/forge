import {
  stageReportSchema,
  stages,
  type AcceptanceSuite,
  type AttemptOutcome,
  type FactoryDependencies,
  type GateResult,
  type RunOutcome,
  type RunRequest,
  type Stage,
  type StageAttemptRecord,
  type StageReport,
  type WorkspaceReference,
} from "../contracts.js";

interface ActiveRun {
  workspace: WorkspaceReference;
  suite?: AcceptanceSuite;
  reports: StageReport[];
  attempts: StageAttemptRecord[];
  correctionUsed: boolean;
  failureEvidence: string[];
}
class RunCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCancelledError";
  }
}


export async function executeTicket(
  request: RunRequest,
  dependencies: FactoryDependencies,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  const now = dependencies.now ?? Date.now;
  const cancellation = signal ?? new AbortController().signal;
  let active: ActiveRun | undefined;

  try {
    cancellation.throwIfAborted();
    const workspace = await dependencies.workspace.prepare(request);
    active = {
      workspace,
      reports: [],
      attempts: [],
      correctionUsed: false,
      failureEvidence: [],
    };
    await dependencies.artifacts.record({
      type: "run-started",
      runId: request.runId,
      details: {
        ticketDigest: request.ticket.digest,
        baseCommit: workspace.baseCommit,
        outputBranch: workspace.branch,
        modelProvider: request.model.provider,
        modelId: request.model.modelId,
        endpoint: redactEndpoint(request.model.endpoint),
      },
    });

    const preflight = await dependencies.verification.preflight(request, workspace);
    await recordGate(dependencies, request.runId, "preflight", preflight);
    if (!preflight.passed) {
      return await finishFailure(request, dependencies, active, preflight.reason ?? "Preflight failed");
    }

    for (const stage of stages) {
      const accepted = await executeStage(request, stage, dependencies, active, cancellation, now);
      if (!accepted) {
        return await finishFailure(request, dependencies, active, `Stage ${stage} exhausted its two-attempt budget`);
      }
    }

    await dependencies.workspace.disposeExecutionResources();
    if (!active.suite) {
      return await finishFailure(request, dependencies, active, "No authoritative acceptance suite was produced");
    }

    await dependencies.verification.integrateSuite(active.workspace, active.suite);
    await dependencies.workspace.snapshot("final-candidate");
    const finalGate = await dependencies.verification.verifyPublished(active.workspace, active.suite);
    await recordGate(dependencies, request.runId, "final", finalGate);
    if (!finalGate.passed) {
      return await finishFailure(request, dependencies, active, finalGate.reason ?? "Final exact-tree verification failed");
    }

    const published = await dependencies.workspace.publishBranch(active.workspace.baseCommit);
    await dependencies.workspace.disposeExecutionResources();
    const outcomeWithoutPath = {
      status: "succeeded" as const,
      runId: request.runId,
      baseCommit: active.workspace.baseCommit,
      outputBranch: published.branch,
      finalCommit: published.commit,
      attempts: active.attempts,
      criteria: active.reports.at(-1)?.criteria ?? [],
      terminalReason: "All stages and exact published-tree checks passed",
    };
    const reportPath = await dependencies.artifacts.finalize(outcomeWithoutPath);
    return { ...outcomeWithoutPath, reportPath };
  } catch (error) {
    if (active) {
      await dependencies.workspace.disposeExecutionResources().catch(() => undefined);
      const cancelled = cancellation.aborted || error instanceof RunCancelledError;
      const cancellationReason = cancellation.aborted
        ? String(cancellation.reason ?? "cancelled")
        : error instanceof RunCancelledError ? error.message : "cancelled";
      const reason = cancelled
        ? `Run cancelled: ${cancellationReason}`
        : `Infrastructure failure: ${error instanceof Error ? error.message : String(error)}`;
      return await finishFailure(request, dependencies, active, reason, cancelled ? "cancelled" : "failed");
    }
    throw error;
  }
}

async function executeStage(
  request: RunRequest,
  stage: Stage,
  dependencies: FactoryDependencies,
  active: ActiveRun,
  signal: AbortSignal,
  now: () => number,
): Promise<boolean> {
  for (const attempt of [1, 2] as const) {
    signal.throwIfAborted();
    const attemptId = `${request.runId}-${stage}-${attempt}`;
    const sessionId = attemptId;
    const snapshot = await dependencies.workspace.snapshot(`${stage}-before-${attempt}`);
    const outcome = await dependencies.backend.runAttempt({
      runId: request.runId,
      stage,
      attempt,
      attemptId,
      sessionId,
      workspacePath: active.workspace.path,
      deadline: now() + request.attemptTimeoutMs,
      context: {
        ticket: request.ticket,
        stage,
        attempt,
        diffFromBase: snapshot.id,
        standards: request.standards,
        ...(active.suite ? { acceptanceSuite: active.suite } : {}),
        priorReports: active.reports,
        failureEvidence: active.failureEvidence,
      },
      correction: false,
    }, signal);
    await dependencies.backend.stopAttempt(outcome.attemptId);

    const report = outcome.status === "completed"
      ? stageReportSchema.safeParse(outcome.report)
      : undefined;
    active.attempts.push({
      stage,
      attempt,
      sessionId: outcome.sessionId,
      status: outcome.status === "completed" && (!report?.success || report.data.stage !== stage)
        ? "rejected"
        : outcome.status,
      evidence: outcome.evidence,
    });
    await dependencies.artifacts.record({
      type: "attempt-finished",
      runId: request.runId,
      stage,
      attempt,
      details: {
        status: outcome.status,
        sessionId: outcome.sessionId,
        evidence: outcome.evidence,
        ...(outcome.status !== "completed"
          ? { error: outcome.error }
          : report?.success
            ? { report: report.data }
            : { reportProblems: report?.error.issues ?? [] }),
      },
    });
    if (outcome.status === "cancelled") {
      throw new RunCancelledError(`Attempt ${outcome.attemptId} was cancelled`);
    }


    if (outcome.status !== "completed" || !report?.success || report.data.stage !== stage) {
      active.failureEvidence = outcome.status === "completed"
        ? [...outcome.evidence, "Missing, malformed, or wrong-stage report"]
        : [...outcome.evidence, outcome.error];
      continue;
    }

    if (report.data.status === "suspected-test-defect") {
      if (attempt === 2 || active.correctionUsed || stage === "test-design" || !active.suite) {
        active.failureEvidence = [...outcome.evidence, "Acceptance-test correction budget unavailable"];
        return false;
      }
      active.failureEvidence = [...outcome.evidence, ...report.data.unresolvedIssues];
      const corrected = await executeCorrection(request, dependencies, active, signal, now);
      if (!corrected) return false;
      active.failureEvidence = ["Authoritative suite corrected; prior suite evidence invalidated"];
      continue;
    }

    if (report.data.status !== "completed" || (stage !== "test-design" && !allCriteriaMet(request, report.data))) {
      active.failureEvidence = [...outcome.evidence, ...report.data.unresolvedIssues];
      continue;
    }

    if (stage === "test-design") {
      const validation = await dependencies.verification.validateCandidate(request, active.workspace, report.data);
      await dependencies.artifacts.record({
        type: "candidate-suite-validated",
        runId: request.runId,
        stage,
        attempt,
        details: {
          accepted: validation.accepted,
          passed: validation.passed,
          mapping: validation.mapping ?? [],
          checks: validation.checks,
          ...(validation.reason ? { reason: validation.reason } : {}),
        },
      });
      if (!validation.accepted || !validation.passed) {
        active.failureEvidence = validation.reason ? [validation.reason] : ["Candidate acceptance suite rejected"];
        continue;
      }
      active.suite = await dependencies.verification.freezeSuite(validation);
    } else {
      if (!active.suite) return false;
      const gate = await dependencies.verification.runChecks(stage, active.workspace, active.suite);
      await recordGate(dependencies, request.runId, stage, gate);
      if (!gate.passed) {
        active.failureEvidence = gate.reason ? [gate.reason] : ["Trusted checks failed"];
        continue;
      }
    }

    await dependencies.artifacts.record({
      type: "stage-report-accepted",
      runId: request.runId,
      stage,
      attempt,
      details: { report: report.data, suite: active.suite },
    });
    active.reports.push(report.data);
    active.failureEvidence = [];
    return true;
  }
  return false;
}

async function executeCorrection(
  request: RunRequest,
  dependencies: FactoryDependencies,
  active: ActiveRun,
  signal: AbortSignal,
  now: () => number,
): Promise<boolean> {
  active.correctionUsed = true;
  const attemptId = `${request.runId}-acceptance-correction-1`;
  const productionIdentity = await dependencies.verification.captureProductionIdentity(active.workspace);
  const outcome = await dependencies.backend.runAttempt({
    runId: request.runId,
    stage: "test-design",
    attempt: 1,
    attemptId,
    sessionId: attemptId,
    workspacePath: active.workspace.path,
    deadline: now() + request.attemptTimeoutMs,
    context: {
      ticket: request.ticket,
      stage: "test-design",
      attempt: 1,
      diffFromBase: (await dependencies.workspace.snapshot("correction-before")).id,
      standards: request.standards,
      ...(active.suite ? { acceptanceSuite: active.suite } : {}),
      priorReports: active.reports,
      failureEvidence: active.failureEvidence,
    },
    correction: true,
  }, signal);
  await dependencies.backend.stopAttempt(outcome.attemptId);
  const parsedReport = outcome.status === "completed"
    ? stageReportSchema.safeParse(outcome.report)
    : undefined;
  active.attempts.push({
    stage: "test-design",
    attempt: 1,
    sessionId: outcome.sessionId,
    status: outcome.status === "completed" && !parsedReport?.success ? "rejected" : outcome.status,
    evidence: outcome.evidence,
  });
  await dependencies.artifacts.record({
    type: "correction-attempt-finished",
    runId: request.runId,
    stage: "test-design",
    attempt: 1,
    details: {
      status: outcome.status,
      sessionId: outcome.sessionId,
      evidence: outcome.evidence,
      ...(outcome.status !== "completed"
        ? { error: outcome.error }
        : parsedReport?.success
          ? { report: parsedReport.data }
          : { reportProblems: parsedReport?.error.issues ?? [] }),
    },
  });
  if (outcome.status === "cancelled") {
    throw new RunCancelledError(`Correction attempt ${outcome.attemptId} was cancelled`);
  }
  if (outcome.status !== "completed" || !active.suite) return false;

  const report = parsedReport;
  if (!report?.success || report.data.stage !== "test-design" || report.data.status !== "completed") return false;
  const validation = await dependencies.verification.validateCorrection(
    request,
    active.workspace,
    report.data,
    active.suite,
    productionIdentity,
  );
  await dependencies.artifacts.record({
    type: "correction-suite-validated",
    runId: request.runId,
    stage: "test-design",
    attempt: 1,
    details: {
      accepted: validation.accepted,
      passed: validation.passed,
      mapping: validation.mapping ?? [],
      checks: validation.checks,
      ...(validation.reason ? { reason: validation.reason } : {}),
    },
  });
  if (!validation.accepted || !validation.passed) return false;
  active.suite = await dependencies.verification.freezeSuite(validation);
  await dependencies.artifacts.record({
    type: "acceptance-suite-corrected",
    runId: request.runId,
    details: {
      version: active.suite.version,
      digest: active.suite.digest,
      mapping: validation.mapping ?? [],
      checks: validation.checks,
    },
  });
  return true;
}

function allCriteriaMet(request: RunRequest, report: StageReport): boolean {
  const verdicts = new Map(report.criteria.map((criterion) => [criterion.id, criterion.verdict]));
  return request.ticket.criteria.every((criterion) => verdicts.get(criterion.id) === "met");
}

async function finishFailure(
  request: RunRequest,
  dependencies: FactoryDependencies,
  active: ActiveRun,
  terminalReason: string,
  status: "failed" | "cancelled" = "failed",
): Promise<RunOutcome> {
  const outcomeWithoutPath = {
    status,
    runId: request.runId,
    baseCommit: active.workspace.baseCommit,
    outputBranch: active.workspace.branch,
    attempts: active.attempts,
    criteria: active.reports.at(-1)?.criteria ?? [],
    terminalReason,
  };
  const reportPath = await dependencies.artifacts.finalize(outcomeWithoutPath);
  return { ...outcomeWithoutPath, reportPath };
}

async function recordGate(
  dependencies: FactoryDependencies,
  runId: string,
  gate: string,
  result: GateResult,
): Promise<void> {
  await dependencies.artifacts.record({
    type: "gate-finished",
    runId,
    details: {
      gate,
      passed: result.passed,
      ...(result.reason ? { reason: result.reason } : {}),
      checks: result.checks,
    },
  });
}

function redactEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.username = "";
  url.password = "";
  url.search = "";
  return url.toString();
}
