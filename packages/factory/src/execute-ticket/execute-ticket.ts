import { readFile } from "node:fs/promises";
import {
  pullRequestReportSchema,
  stageReportSchema,
  stages,
  type AcceptanceSuite,
  type AnalysisWorkspace,
  type AttemptOutcome,
  type AgentOperation,
  type CorrectionFailureCode,
  type FactoryDependencies,
  type EvidenceArtifactReference,
  type Finding,
  type FindingSubmission,
  type GateResult,
  type HostEvidenceBundle,
  type PullRequestReport,
  type PullRequestAttemptOutcome,
  type RunOutcome,
  type RunRequest,
  type Snapshot,
  type Stage,
  type StageAttemptRecord,
  type SkillRole,
  type ReportReference,
  type StageReport,
  type WorkspaceReference,
} from "../contracts.js";
import { renderPullRequestMarkdown } from "../pull-request.js";
import { RunEventWriter } from "../run-event-writer.js";

interface ActiveRun {
  workspace: WorkspaceReference;
  suite?: AcceptanceSuite;
  reports: StageReport[];
  reportReferences: ReportReference[];
  evidenceBundles: HostEvidenceBundle[];
  findings: Finding[];
  attempts: StageAttemptRecord[];
  correctionUsed: boolean;
  repairRoundsUsed: number;
  latestApprovedReviewTreeId?: string;
  baseTreeId?: string;
}

type StageResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string; readonly reasonCode?: CorrectionFailureCode };

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
  const events = new RunEventWriter({
    runId: request.runId,
    artifacts: dependencies.artifacts,
    ...(dependencies.progress === undefined ? {} : { progress: dependencies.progress }),
    now,
  });
  const cancellation = signal ?? new AbortController().signal;
  let active: ActiveRun | undefined;

  try {
    cancellation.throwIfAborted();
    await events.emit({
      type: "run-preparing",
      eventClass: "transition",
      operationId: "workspace-prepare",
      details: {
        sourcePath: request.repository.sourcePath,
        baseRef: request.repository.baseRef,
        outputBranch: request.repository.outputBranch,
      },
    });
    const workspace = await dependencies.workspace.prepare(request);
    active = {
      workspace,
      reports: [],
      reportReferences: [],
      evidenceBundles: [],
      findings: [],
      attempts: [],
      correctionUsed: false,
      repairRoundsUsed: 0,
    };
    await events.emit({
      type: "run-started",
      eventClass: "transition",
      details: {
        ticketDigest: request.ticket.digest,
        baseCommit: workspace.baseCommit,
        outputBranch: workspace.branch,
        modelProvider: request.model.provider,
        modelId: request.model.modelId,
      },
    });

    await events.emit({
      type: "preflight-started",
      eventClass: "transition",
      operationId: "preflight",
      details: { operationId: "preflight" },
    });
    const preflight = await dependencies.verification.preflight(request, workspace);
    await recordGate(events, "preflight", preflight);
    await captureGateEvidence(request, dependencies, active, "preflight", preflight);
    if (!preflight.passed) {
      return await finishFailure(request, dependencies, events, active, preflight.reason ?? "Preflight failed");
    }

    for (const stage of stages) {
      const result = await executeStage(request, stage, dependencies, events, active, cancellation, now);
      if (!result.accepted) {
        await events.emit({
          type: "stage-finished",
          eventClass: "transition",
          stage,
          operationId: stage,
          details: {
            accepted: false,
            reason: result.reason,
            ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
          },
        });
        return await finishFailure(request, dependencies, events, active, result.reason, "failed", result.reasonCode);
      }
    }

    await dependencies.workspace.disposeExecutionResources();
    if (!active.suite) {
      return await finishFailure(request, dependencies, events, active, "No authoritative acceptance suite was produced");
    }
    const approvedCandidate = await snapshotWorkspace(request, dependencies, events, "approved-candidate", cancellation);
    if (active.latestApprovedReviewTreeId !== approvedCandidate.id || openBlockingFindings(active).length > 0) {
      return await finishFailure(
        request,
        dependencies,
        events,
        active,
        "Publication requires an approved review for the current candidate identity and no unresolved blocking finding",
      );
    }

    await events.emit({
      type: "gate-started",
      eventClass: "transition",
      operationId: "integrate-suite",
      details: { gate: "integrate-suite", suiteVersion: active.suite.version },
    });
    await dependencies.verification.integrateSuite(active.workspace, active.suite);
    await events.emit({
      type: "gate-finished",
      eventClass: "transition",
      operationId: "integrate-suite",
      details: { gate: "integrate-suite", passed: true, checkCount: 0, checks: [] },
    });
    const finalSnapshot = await snapshotWorkspace(request, dependencies, events, "final-candidate", cancellation);
    await events.emit({
      type: "gate-started",
      eventClass: "transition",
      operationId: "final",
      details: { gate: "final" },
    });
    const finalGate = await dependencies.verification.verifyFinalCandidate(active.workspace, active.suite);
    await recordGate(events, "final", finalGate);
    await captureGateEvidence(request, dependencies, active, "final", finalGate);
    if (!finalGate.passed) {
      return await finishFailure(request, dependencies, events, active, finalGate.reason ?? "Final exact-tree verification failed");
    }
    const pullRequestReport = await executePullRequestStep(
      request,
      dependencies,
      active,
      cancellation,
      now,
      events,
      finalSnapshot,
      finalGate,
    );
    if (pullRequestReport === undefined) {
      return await finishFailure(
        request,
        dependencies,
        events,
        active,
        "Pull-request step exhausted its two-attempt budget",
      );
    }
    const pullRequestMarkdown = renderPullRequestMarkdown(
      pullRequestReport,
      finalGate.checks,
      active.reports.at(-1)?.criteria ?? [],
    );
    const pullRequestPath = await dependencies.artifacts.attach("PR.md", pullRequestMarkdown);
    await events.emit({
      type: "pull-request-drafted",
      eventClass: "transition",
      stage: "pull-request",
      details: { path: pullRequestPath, snapshotId: finalSnapshot.id },
    });


    await events.emit({
      type: "publication-started",
      eventClass: "transition",
      operationId: "publish-branch",
      details: { outputBranch: active.workspace.branch },
    });
    const published = await dependencies.workspace.publishBranch(active.workspace.baseCommit);
    await events.emit({
      type: "publication-finished",
      eventClass: "transition",
      operationId: "publish-branch",
      details: { outputBranch: published.branch, commit: published.commit },
    });
    await dependencies.workspace.disposeExecutionResources();
    const outcomeWithoutPath = {
      status: "succeeded" as const,
      runId: request.runId,
      baseCommit: active.workspace.baseCommit,
      outputBranch: published.branch,
      finalCommit: published.commit,
      pullRequestPath,
      attempts: active.attempts,
      criteria: active.reports.at(-1)?.criteria ?? [],
      repairRoundsUsed: active.repairRoundsUsed,
      findings: active.findings,
      ...(active.latestApprovedReviewTreeId === undefined
        ? {}
        : { approvedReviewTreeId: active.latestApprovedReviewTreeId }),
      terminalReason: "All stages, exact final-tree checks, and pull-request drafting passed",
    };
    await events.emit({
      type: "run-finalizing",
      eventClass: "transition",
      details: { status: "succeeded", reason: outcomeWithoutPath.terminalReason },
    });
    await events.emit({
      type: "run-finished",
      eventClass: "transition",
      details: { status: "succeeded", reason: outcomeWithoutPath.terminalReason },
    });
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
      return await finishFailure(request, dependencies, events, active, reason, cancelled ? "cancelled" : "failed");
    }
    throw error;
  }
}

async function executeStage(
  request: RunRequest,
  stage: Stage,
  dependencies: FactoryDependencies,
  events: RunEventWriter,
  active: ActiveRun,
  signal: AbortSignal,
  now: () => number,
): Promise<StageResult> {
  if (stage === "review") {
    return executeReviewOperation(request, dependencies, events, active, signal, now, "review");
  }

  for (const attempt of [1, 2] as const) {
    signal.throwIfAborted();
    const attemptId = `${request.runId}-${stage}-${attempt}`;
    const snapshot = await snapshotWorkspace(
      request,
      dependencies,
      events,
      `${stage}-before-${attempt}`,
      signal,
      stage,
      attempt,
    );
    if (stage === "test-design" && active.baseTreeId === undefined) active.baseTreeId = snapshot.id;
    const deadline = now() + request.attemptTimeoutMs;
    const deadlineAt = new Date(deadline).toISOString();
    await events.emit({
      type: "attempt-preparing",
      eventClass: "transition",
      stage,
      attempt,
      operationId: attemptId,
      deadlineAt,
      details: { attemptId, sessionId: attemptId, operation: stage },
    });
    const outcome = await dependencies.backend.runAttempt({
      runId: request.runId,
      stage,
      operation: stage,
      attempt,
      attemptId,
      sessionId: attemptId,
      workspacePath: active.workspace.path,
      deadline,
      context: {
        ticket: request.ticket,
        stage,
        operation: stage,
        attempt,
        baseCommit: active.workspace.baseCommit,
        snapshotId: snapshot.id,
        standards: skillsFor(request, stage),
        ...(active.suite ? { acceptanceSuite: active.suite } : {}),
        reportReferences: active.reportReferences,
        evidenceBundles: active.evidenceBundles,
      },
      candidateReadonly: false,
    }, signal, async (event) => {
      await events.emit({
        ...event,
        stage,
        attempt,
        operationId: event.operationId ?? attemptId,
        deadlineAt: event.deadlineAt ?? deadlineAt,
      });
    });

    if (outcome.status !== "shutdown-stalled") await dependencies.backend.stopAttempt(outcome.attemptId);
    const parsed = outcome.status === "completed" ? stageReportSchema.safeParse(outcome.report) : undefined;
    const report = parsed?.success ? parsed.data : undefined;
    const acceptedReport = outcome.status === "completed"
      && report !== undefined
      && report.stage === stage
      && report.operation === stage
      && ((stage === "test-design" || stage === "implementation")
        ? report.kind === "authoring"
        : report.kind === "refactor");
    active.attempts.push({
      stage,
      attempt,
      sessionId: outcome.sessionId,
      status: outcome.status === "completed" && !acceptedReport ? "rejected" : outcome.status,
      evidence: outcome.evidence,
    });
    await recordAttemptReport(events, stage, attempt, attemptId, outcome, report, parsed?.success ? [] : parsed?.error.issues ?? [], acceptedReport);
    if (outcome.status === "cancelled") throw new RunCancelledError(`Attempt ${outcome.attemptId} was cancelled`);
    if (outcome.status === "shutdown-stalled") {
      throw new Error(`Attempt ${outcome.attemptId} did not stop after cancellation`);
    }
    if (!acceptedReport || report === undefined) {
      appendOperationalEvidence(active, request.runId, attemptId, stage, outcome.status === "completed"
        ? "Missing, malformed, wrong-stage, or wrong-operation report"
        : outcome.error);
      continue;
    }

    await retainReport(dependencies, active, report, stage);
    if (report.status === "suspected-test-defect") {
      if (attempt === 2 || active.correctionUsed || stage === "test-design" || !active.suite) {
        const reason = `Acceptance-test correction budget unavailable for ${stage} attempt ${attempt}`;
        appendOperationalEvidence(active, request.runId, attemptId, stage, reason);
        return { accepted: false, reason, reasonCode: "correction-budget-unavailable" };
      }
      const corrected = await executeCorrection(request, dependencies, events, active, signal, now);
      if (!corrected.accepted) return corrected;
      continue;
    }
    if (report.status !== "completed") continue;
    if (stage === "implementation" && !allCriteriaMet(request, report)) continue;

    if (stage === "test-design") {
      await events.emit({
        type: "gate-started",
        eventClass: "transition",
        stage,
        attempt,
        operationId: "candidate-suite",
        details: { gate: "candidate-suite" },
      });
      const validation = await dependencies.verification.validateCandidate(request, active.workspace, report);
      await recordGate(events, "candidate-suite", validation, stage, attempt);
      await captureGateEvidence(request, dependencies, active, "candidate-suite", validation, stage, attemptId);
      if (!validation.accepted || !validation.passed) continue;
      active.suite = await dependencies.verification.freezeSuite(validation);
    } else {
      if (!active.suite) return { accepted: false, reason: "No authoritative acceptance suite was produced" };
      await events.emit({
        type: "gate-started",
        eventClass: "transition",
        stage,
        attempt,
        operationId: stage,
        details: { gate: stage },
      });
      const gate = await dependencies.verification.runChecks(stage, active.workspace, active.suite);
      await recordGate(events, stage, gate, stage, attempt);
      await captureGateEvidence(request, dependencies, active, stage, gate, stage, attemptId);
      if (!gate.passed) continue;
    }

    active.reports.push(report);
    if (report.kind === "refactor") {
      registerFindings(active, report.findings, "refactor", snapshot.id);
      if (openBlockingFindings(active).length > 0) {
        const repaired = await executeRepairs(request, dependencies, events, active, signal, now);
        if (!repaired.accepted) return repaired;
      }
    }
    await events.emit({
      type: "stage-finished",
      eventClass: "transition",
      stage,
      attempt,
      operationId: stage,
      details: { accepted: true, suiteVersion: active.suite?.version },
    });
    return { accepted: true };
  }
  return { accepted: false, reason: `Stage ${stage} exhausted its two-attempt budget` };
}

async function executePullRequestStep(
  request: RunRequest,
  dependencies: FactoryDependencies,
  active: ActiveRun,
  signal: AbortSignal,
  now: () => number,
  events: RunEventWriter,
  finalSnapshot: Snapshot,
  finalGate: GateResult,
): Promise<PullRequestReport | undefined> {
  for (const attempt of [1, 2] as const) {
    signal.throwIfAborted();
    const attemptId = `${request.runId}-pull-request-${attempt}`;
    const analysisOperationId = `${attemptId}-analysis`;
    await events.emit({
      type: "analysis-workspace-started",
      eventClass: "transition",
      stage: "pull-request",
      attempt,
      operationId: analysisOperationId,
      details: { snapshotId: finalSnapshot.id },
    });
    const analysis = await dependencies.workspace.createAnalysisWorkspace(finalSnapshot.id);
    await events.emit({
      type: "analysis-workspace-ready",
      eventClass: "transition",
      stage: "pull-request",
      attempt,
      operationId: analysisOperationId,
      details: { treeId: analysis.treeId },
    });
    const deadline = now() + request.attemptTimeoutMs;
    const deadlineAt = new Date(deadline).toISOString();
    await events.emit({
      type: "attempt-preparing",
      eventClass: "transition",
      stage: "pull-request",
      attempt,
      operationId: attemptId,
      deadlineAt,
      details: { attemptId, sessionId: attemptId },
    });

    let outcome: PullRequestAttemptOutcome;
    try {
      outcome = await dependencies.backend.runPullRequestAttempt({
        runId: request.runId,
        attempt,
        attemptId,
        sessionId: attemptId,
        workspacePath: analysis.path,
        deadline,
        context: {
          ticket: request.ticket,
          baseCommit: active.workspace.baseCommit,
          snapshotId: analysis.treeId,
          standards: skillsFor(request, "pull-request"),
          reportReferences: active.reportReferences,
          evidenceBundles: active.evidenceBundles,
        },
      }, signal, async (event) => {
        await events.emit({
          ...event,
          stage: "pull-request",
          attempt,
          operationId: event.operationId ?? attemptId,
          deadlineAt: event.deadlineAt ?? deadlineAt,
        });
      });
      if (outcome.status !== "shutdown-stalled") {
        await dependencies.backend.stopAttempt(outcome.attemptId);
      }
    } finally {
      await verifyAndDisposeAnalysis(dependencies, analysis);
      await events.emit({
        type: "analysis-workspace-finished",
        eventClass: "transition",
        stage: "pull-request",
        attempt,
        operationId: analysisOperationId,
        details: { disposed: true },
      });
    }

    const parsedReport = outcome.status === "completed"
      ? pullRequestReportSchema.safeParse(outcome.report)
      : undefined;
    const acceptedReport = outcome.status === "completed" && parsedReport?.success;
    active.attempts.push({
      stage: "pull-request",
      attempt,
      sessionId: outcome.sessionId,
      status: outcome.status === "completed" && !acceptedReport ? "rejected" : outcome.status,
      evidence: outcome.evidence,
    });
    await events.emit({
      type: acceptedReport ? "attempt-report-accepted" : "attempt-report-rejected",
      eventClass: "transition",
      stage: "pull-request",
      attempt,
      operationId: attemptId,
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
      throw new RunCancelledError(`Pull-request attempt ${outcome.attemptId} was cancelled`);
    }
    if (outcome.status === "shutdown-stalled") {
      throw new Error(`Pull-request attempt ${outcome.attemptId} did not stop after cancellation`);
    }
    if (outcome.status !== "completed" || !parsedReport?.success) {
      appendOperationalEvidence(active, request.runId, attemptId, "review", outcome.status === "completed"
        ? "Missing or malformed pull-request report"
        : outcome.error);
      continue;
    }
    if (parsedReport.data.status !== "completed" || parsedReport.data.unresolvedIssues.length > 0) {
      continue;
    }
    return parsedReport.data;
  }
  return undefined;
}

async function executeCorrection(
  request: RunRequest,
  dependencies: FactoryDependencies,
  events: RunEventWriter,
  active: ActiveRun,
  signal: AbortSignal,
  now: () => number,
): Promise<StageResult> {
  active.correctionUsed = true;
  const attemptId = `${request.runId}-acceptance-correction-1`;
  const protectedIdentity = await dependencies.verification.captureProtectedContentIdentity(active.workspace);
  const snapshot = await snapshotWorkspace(
    request,
    dependencies,
    events,
    "correction-before",
    signal,
    "test-design",
    1,
  );
  const deadline = now() + request.attemptTimeoutMs;
  const deadlineAt = new Date(deadline).toISOString();
  await events.emit({
    type: "attempt-preparing",
    eventClass: "transition",
    stage: "test-design",
    attempt: 1,
    operationId: attemptId,
    deadlineAt,
    details: { attemptId, sessionId: attemptId, correction: true },
  });
  const outcome = await dependencies.backend.runAttempt({
    runId: request.runId,
    stage: "test-design",
    operation: "acceptance-correction",
    attempt: 1,
    attemptId,
    sessionId: attemptId,
    workspacePath: active.workspace.path,
    deadline,
    context: {
      ticket: request.ticket,
      stage: "test-design",
      operation: "acceptance-correction",
      attempt: 1,
      baseCommit: active.workspace.baseCommit,
      snapshotId: snapshot.id,
      standards: skillsFor(request, "acceptance-correction"),
      ...(active.suite ? { acceptanceSuite: active.suite } : {}),
      reportReferences: active.reportReferences,
      evidenceBundles: active.evidenceBundles,
    },
    candidateReadonly: false,
  }, signal, async (event) => {
    await events.emit({
      ...event,
      stage: "test-design",
      attempt: 1,
      operationId: event.operationId ?? attemptId,
      deadlineAt: event.deadlineAt ?? deadlineAt,
    });
  });
  if (outcome.status !== "shutdown-stalled") {
    await dependencies.backend.stopAttempt(outcome.attemptId);
  }
  const parsedReport = outcome.status === "completed"
    ? stageReportSchema.safeParse(outcome.report)
    : undefined;
  const acceptedReport = outcome.status === "completed"
    && parsedReport?.success
    && parsedReport.data.kind === "authoring"
    && parsedReport.data.stage === "test-design"
    && parsedReport.data.operation === "acceptance-correction";
  active.attempts.push({
    stage: "test-design",
    attempt: 1,
    sessionId: outcome.sessionId,
    status: outcome.status === "completed" && !acceptedReport ? "rejected" : outcome.status,
    evidence: outcome.evidence,
  });
  await events.emit({
    type: acceptedReport ? "attempt-report-accepted" : "attempt-report-rejected",
    eventClass: "transition",
    stage: "test-design",
    attempt: 1,
    operationId: attemptId,
    details: {
      status: outcome.status,
      sessionId: outcome.sessionId,
      correction: true,
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
  if (outcome.status === "shutdown-stalled") {
    throw new Error(`Correction attempt ${outcome.attemptId} did not stop after cancellation`);
  }
  if (outcome.status !== "completed") {
    return {
      accepted: false,
      reason: `Acceptance correction execution failed (${outcome.status}): ${outcome.error}`,
      reasonCode: "correction-execution-failed",
    };
  }
  if (!active.suite || !parsedReport?.success || !acceptedReport || parsedReport.data.status !== "completed") {
    return {
      accepted: false,
      reason: "Acceptance correction rejected: missing authoritative suite or valid completed test-design report",
      reasonCode: "correction-rejected",
    };
  }
  await retainReport(dependencies, active, parsedReport.data, "acceptance-correction");

  await events.emit({
    type: "gate-started",
    eventClass: "transition",
    stage: "test-design",
    attempt: 1,
    operationId: "acceptance-correction",
    details: { gate: "acceptance-correction" },
  });
  const validation = await dependencies.verification.validateCorrection(
    request,
    active.workspace,
    parsedReport.data,
    active.suite,
    protectedIdentity,
  );
  await events.emit({
    type: "gate-finished",
    eventClass: "transition",
    stage: "test-design",
    attempt: 1,
    operationId: "acceptance-correction",
    details: {
      gate: "acceptance-correction",
      accepted: validation.accepted,
      passed: validation.passed,
      mapping: validation.mapping ?? [],
      checks: validation.checks,
      ...(validation.reason ? { reason: validation.reason } : {}),
      ...(!validation.accepted || !validation.passed ? { reasonCode: validation.reasonCode ?? "correction-rejected" } : {}),
      ...(validation.diagnostics ? { diagnostics: validation.diagnostics } : {}),
    },
  });
  await captureGateEvidence(
    request,
    dependencies,
    active,
    "acceptance-correction",
    validation,
    "test-design",
    attemptId,
  );
  if (!validation.accepted || !validation.passed) {
    return {
      accepted: false,
      reason: validation.reason ?? "Acceptance correction rejected",
      reasonCode: validation.reasonCode ?? "correction-rejected",
    };
  }
  active.suite = await dependencies.verification.freezeSuite(validation);
  await events.emit({
    type: "acceptance-suite-corrected",
    eventClass: "transition",
    details: {
      version: active.suite.version,
      digest: active.suite.digest,
      mapping: validation.mapping ?? [],
      checks: validation.checks,
    },
  });
  return { accepted: true };
}

async function executeReviewOperation(
  request: RunRequest,
  dependencies: FactoryDependencies,
  events: RunEventWriter,
  active: ActiveRun,
  signal: AbortSignal,
  now: () => number,
  operation: "review" | "re-review",
): Promise<StageResult> {
  const authorizedFindings = operation === "re-review" ? openBlockingFindings(active) : [];
  for (const attempt of [1, 2] as const) {
    signal.throwIfAborted();
    const operationSuffix = operation === "re-review" ? `-${active.repairRoundsUsed}` : "";
    const attemptId = `${request.runId}-${operation}${operationSuffix}-${attempt}`;
    const snapshot = await snapshotWorkspace(request, dependencies, events, `${operation}${operationSuffix}-before-${attempt}`, signal, "review", attempt);
    const packageBaseline = operation === "review" ? active.baseTreeId : authorizedFindings[0]?.reviewedTreeId;
    if (packageBaseline === undefined) {
      return { accepted: false, reason: `${operation} is missing its reviewed baseline identity` };
    }
    await attachChangePackage(request, dependencies, active, operation, packageBaseline, snapshot.id, attemptId);
    const analysisOperationId = `${attemptId}-analysis`;
    await events.emit({
      type: "analysis-workspace-started",
      eventClass: "transition",
      stage: operation,
      attempt,
      operationId: analysisOperationId,
      details: { snapshotId: snapshot.id, operation },
    });
    const analysis = await dependencies.workspace.createAnalysisWorkspace(snapshot.id);
    await events.emit({
      type: "analysis-workspace-ready",
      eventClass: "transition",
      stage: operation,
      attempt,
      operationId: analysisOperationId,
      details: { treeId: analysis.treeId, readonly: true },
    });
    const deadline = now() + request.attemptTimeoutMs;
    const deadlineAt = new Date(deadline).toISOString();
    await events.emit({
      type: "attempt-preparing",
      eventClass: "transition",
      stage: operation,
      attempt,
      operationId: attemptId,
      deadlineAt,
      details: {
        attemptId,
        sessionId: attemptId,
        operation,
        repairRound: active.repairRoundsUsed || undefined,
        reviewedTreeId: authorizedFindings[0]?.reviewedTreeId,
        openBlockers: authorizedFindings.length,
      },
    });

    let outcome: AttemptOutcome;
    try {
      outcome = await dependencies.backend.runAttempt({
        runId: request.runId,
        stage: "review",
        operation,
        attempt,
        attemptId,
        sessionId: attemptId,
        workspacePath: analysis.path,
        deadline,
        context: {
          ticket: request.ticket,
          stage: "review",
          operation,
          attempt,
          baseCommit: active.workspace.baseCommit,
          snapshotId: analysis.treeId,
          standards: skillsFor(request, operation),
          ...(active.suite ? { acceptanceSuite: active.suite } : {}),
          reportReferences: active.reportReferences,
          evidenceBundles: active.evidenceBundles,
          ...(authorizedFindings.length === 0 ? {} : { authorizedFindings }),
          ...(operation === "re-review" ? { repairRound: active.repairRoundsUsed as 1 | 2 } : {}),
          ...(operation === "re-review" && authorizedFindings[0] !== undefined
            ? { reviewedTreeId: authorizedFindings[0].reviewedTreeId }
            : {}),
        },
        candidateReadonly: true,
      }, signal, async (event) => {
        await events.emit({
          ...event,
          stage: operation,
          attempt,
          operationId: event.operationId ?? attemptId,
          deadlineAt: event.deadlineAt ?? deadlineAt,
        });
      });
      if (outcome.status !== "shutdown-stalled") await dependencies.backend.stopAttempt(outcome.attemptId);
    } finally {
      await verifyAndDisposeAnalysis(dependencies, analysis);
      await events.emit({
        type: "analysis-workspace-finished",
        eventClass: "transition",
        stage: operation,
        attempt,
        operationId: analysisOperationId,
        details: { disposed: true, candidateUnchanged: true },
      });
    }

    const parsed = outcome.status === "completed" ? stageReportSchema.safeParse(outcome.report) : undefined;
    const report = parsed?.success ? parsed.data : undefined;
    const acceptedReport = outcome.status === "completed"
      && report !== undefined
      && report.operation === operation
      && report.kind === operation;
    active.attempts.push({
      stage: operation,
      attempt,
      sessionId: outcome.sessionId,
      status: outcome.status === "completed" && !acceptedReport ? "rejected" : outcome.status,
      evidence: outcome.evidence,
    });
    await recordAttemptReport(events, operation, attempt, attemptId, outcome, report, parsed?.success ? [] : parsed?.error.issues ?? [], acceptedReport);
    if (outcome.status === "cancelled") throw new RunCancelledError(`${operation} attempt ${outcome.attemptId} was cancelled`);
    if (outcome.status === "shutdown-stalled") {
      throw new Error(`${operation} attempt ${outcome.attemptId} did not stop after cancellation`);
    }
    if (!acceptedReport || report === undefined) {
      appendOperationalEvidence(active, request.runId, attemptId, "review", outcome.status === "completed"
        ? `Missing or malformed ${operation} report`
        : outcome.error);
      continue;
    }

    await retainReport(dependencies, active, report, operation);
    if (report.status !== "completed") continue;
    active.reports.push(report);
    if (report.kind === "review") {
      registerFindings(active, report.findings, "review", snapshot.id);
      const blocking = openBlockingFindings(active);
      if (report.verdict === "approved") {
        if (blocking.length > 0 || !allCriteriaMet(request, report)) {
          return { accepted: false, reason: "Review attempted approval with unresolved blocking findings or unmet criteria" };
        }
        active.latestApprovedReviewTreeId = snapshot.id;
        return { accepted: true };
      }
      if (report.verdict === "unverifiable") return { accepted: false, reason: "Review could not verify the candidate" };
      if (blocking.length === 0) {
        return { accepted: false, reason: "Review required changes without a supported blocking finding" };
      }
      return executeRepairs(request, dependencies, events, active, signal, now);
    }

    const submittedIds = new Set(authorizedFindings.map(({ id }) => id));
    const verdictIds = new Set(report.findingVerdicts.map(({ findingId }) => findingId));
    if (submittedIds.size !== verdictIds.size || [...submittedIds].some((id) => !verdictIds.has(id))) {
      return { accepted: false, reason: "Re-review did not verdict every authorized finding exactly once" };
    }
    for (const verdict of report.findingVerdicts) {
      const finding = active.findings.find(({ id }) => id === verdict.findingId);
      if (finding === undefined) return { accepted: false, reason: `Re-review referenced unknown finding ${verdict.findingId}` };
      const lifecycle = verdict.verdict === "resolved"
        ? "verified-resolved"
        : verdict.verdict === "dismissed"
          ? "dismissed"
          : "open";
      replaceFinding(active, {
        ...finding,
        lifecycle,
        ...(verdict.verdict === "unresolved" ? { reviewedTreeId: snapshot.id } : {}),
      });
    }
    registerFindings(active, report.newFindings, "re-review", snapshot.id);
    if (report.verdict === "approved" && openBlockingFindings(active).length === 0) {
      active.latestApprovedReviewTreeId = snapshot.id;
      return { accepted: true };
    }
    return { accepted: false, reason: "Re-review left blocking findings unresolved" };
  }
  return { accepted: false, reason: `${operation} exhausted its two-attempt execution budget` };
}

async function executeRepairs(
  request: RunRequest,
  dependencies: FactoryDependencies,
  events: RunEventWriter,
  active: ActiveRun,
  signal: AbortSignal,
  now: () => number,
): Promise<StageResult> {
  while (openBlockingFindings(active).length > 0) {
    if (active.repairRoundsUsed >= 2) {
      return { accepted: false, reason: "Shared two-round defect-repair budget exhausted with blocking findings unresolved" };
    }
    active.repairRoundsUsed += 1;
    const repaired = await executeRepairOperation(request, dependencies, events, active, signal, now);
    if (!repaired.accepted) return repaired;
    const reviewed = await executeReviewOperation(request, dependencies, events, active, signal, now, "re-review");
    if (reviewed.accepted) return reviewed;
    if (openBlockingFindings(active).length === 0) return reviewed;
  }
  return { accepted: true };
}

async function executeRepairOperation(
  request: RunRequest,
  dependencies: FactoryDependencies,
  events: RunEventWriter,
  active: ActiveRun,
  signal: AbortSignal,
  now: () => number,
): Promise<StageResult> {
  const authorizedFindings = openBlockingFindings(active);
  const round = active.repairRoundsUsed as 1 | 2;
  const reviewedTreeId = authorizedFindings[0]?.reviewedTreeId;
  for (const attempt of [1, 2] as const) {
    signal.throwIfAborted();
    const attemptId = `${request.runId}-repair-${round}-${attempt}`;
    const snapshot = await snapshotWorkspace(request, dependencies, events, `repair-${round}-before-${attempt}`, signal, "implementation", attempt);
    const deadline = now() + request.attemptTimeoutMs;
    const deadlineAt = new Date(deadline).toISOString();
    await events.emit({
      type: "attempt-preparing",
      eventClass: "transition",
      stage: "repair",
      attempt,
      operationId: attemptId,
      deadlineAt,
      details: {
        attemptId,
        sessionId: attemptId,
        operation: "repair",
        repairRound: round,
        reviewedTreeId,
        openBlockers: authorizedFindings.length,
      },
    });
    const outcome = await dependencies.backend.runAttempt({
      runId: request.runId,
      stage: "implementation",
      operation: "repair",
      attempt,
      attemptId,
      sessionId: attemptId,
      workspacePath: active.workspace.path,
      deadline,
      context: {
        ticket: request.ticket,
        stage: "implementation",
        operation: "repair",
        attempt,
        baseCommit: active.workspace.baseCommit,
        snapshotId: snapshot.id,
        standards: skillsFor(request, "repair"),
        ...(active.suite ? { acceptanceSuite: active.suite } : {}),
        reportReferences: active.reportReferences,
        evidenceBundles: active.evidenceBundles,
        authorizedFindings,
        repairRound: round,
        ...(reviewedTreeId === undefined ? {} : { reviewedTreeId }),
      },
      candidateReadonly: false,
    }, signal, async (event) => {
      await events.emit({
        ...event,
        stage: "repair",
        attempt,
        operationId: event.operationId ?? attemptId,
        deadlineAt: event.deadlineAt ?? deadlineAt,
      });
    });
    if (outcome.status !== "shutdown-stalled") await dependencies.backend.stopAttempt(outcome.attemptId);
    const parsed = outcome.status === "completed" ? stageReportSchema.safeParse(outcome.report) : undefined;
    const report = parsed?.success ? parsed.data : undefined;
    const acceptedReport = outcome.status === "completed" && report?.kind === "repair" && report.operation === "repair";
    active.attempts.push({
      stage: "repair",
      attempt,
      sessionId: outcome.sessionId,
      status: outcome.status === "completed" && !acceptedReport ? "rejected" : outcome.status,
      evidence: outcome.evidence,
    });
    await recordAttemptReport(events, "repair", attempt, attemptId, outcome, report, parsed?.success ? [] : parsed?.error.issues ?? [], acceptedReport);
    if (outcome.status === "cancelled") throw new RunCancelledError(`Repair attempt ${outcome.attemptId} was cancelled`);
    if (outcome.status === "shutdown-stalled") {
      throw new Error(`Repair attempt ${outcome.attemptId} did not stop after cancellation`);
    }
    if (!acceptedReport || report?.kind !== "repair" || report.status !== "completed") continue;

    const authorizedIds = new Set(authorizedFindings.map(({ id }) => id));
    const claimIds = new Set(report.claims.map(({ findingId }) => findingId));
    if (authorizedIds.size !== claimIds.size || [...authorizedIds].some((id) => !claimIds.has(id))) {
      appendOperationalEvidence(active, request.runId, attemptId, "implementation", "Repair claims did not match every authorized finding ID");
      continue;
    }
    if (report.claims.some(({ findingId }) => !authorizedIds.has(findingId))) {
      appendOperationalEvidence(active, request.runId, attemptId, "implementation", "Repair claimed an unauthorized finding ID");
      continue;
    }
    await retainReport(dependencies, active, report, "repair");
    for (const finding of authorizedFindings) replaceFinding(active, { ...finding, lifecycle: "repair-claimed" });
    if (!active.suite) return { accepted: false, reason: "Repair cannot run without an authoritative acceptance suite" };
    const gate = await dependencies.verification.runChecks("implementation", active.workspace, active.suite);
    await recordGate(events, `repair-${round}`, gate, "implementation", attempt);
    await captureGateEvidence(request, dependencies, active, `repair-${round}`, gate, "implementation", attemptId);
    if (!gate.passed) continue;
    active.reports.push(report);
    return { accepted: true };
  }
  return { accepted: false, reason: `Repair round ${round} exhausted its two-attempt execution budget` };
}

function registerFindings(
  active: ActiveRun,
  submissions: readonly FindingSubmission[],
  operation: AgentOperation,
  reviewedTreeId: string,
): void {
  for (const submission of submissions) {
    const id = `F-${String(active.findings.length + 1).padStart(4, "0")}`;
    active.findings.push({
      id,
      originatingOperation: operation,
      reviewedTreeId,
      category: submission.category,
      severity: submission.severity,
      ...(submission.criterionId === undefined ? {} : { criterionId: submission.criterionId }),
      ...(submission.repositoryRule === undefined ? {} : { repositoryRule: submission.repositoryRule }),
      ...(submission.location === undefined ? {} : { location: submission.location }),
      ...(submission.affectedContract === undefined ? {} : { affectedContract: submission.affectedContract }),
      scenario: submission.scenario,
      evidenceReferences: submission.evidenceReferences,
      ...(submission.expected === undefined ? {} : { expected: submission.expected }),
      ...(submission.observed === undefined ? {} : { observed: submission.observed }),
      lifecycle: "open",
    });
  }
}

function openBlockingFindings(active: ActiveRun): Finding[] {
  return active.findings.filter(({ severity, lifecycle }) =>
    severity === "blocking" && lifecycle !== "verified-resolved" && lifecycle !== "dismissed"
  );
}

function replaceFinding(active: ActiveRun, replacement: Finding): void {
  const index = active.findings.findIndex(({ id }) => id === replacement.id);
  if (index < 0) throw new Error(`Cannot update unknown finding ${replacement.id}`);
  active.findings[index] = replacement;
}

async function snapshotWorkspace(
  request: RunRequest,
  dependencies: FactoryDependencies,
  events: RunEventWriter,
  label: string,
  signal: AbortSignal,
  stage?: Stage,
  attempt?: number,
): Promise<Snapshot> {
  const timeoutMs = request.orchestrationTimeoutMs ?? 60_000;
  const deadline = (dependencies.now ?? Date.now)() + timeoutMs;
  await events.emit({
    type: "workspace-snapshot-started",
    eventClass: "transition",
    ...(stage === undefined ? {} : { stage }),
    ...(attempt === undefined ? {} : { attempt }),
    operationId: label,
    deadlineAt: new Date(deadline).toISOString(),
    details: { label, timeoutMs },
  });

  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error(`Workspace snapshot '${label}' exceeded its ${timeoutMs}ms orchestration deadline`)),
    timeoutMs,
  );
  timer.unref();
  const cancelled = Promise.withResolvers<never>();
  const onAbort = () => cancelled.reject(signal.reason ?? new Error("Workspace snapshot cancelled"));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    const snapshot = await Promise.race([
      dependencies.workspace.snapshot(label),
      timeout.promise,
      cancelled.promise,
    ]);
    await events.emit({
      type: "workspace-snapshot-finished",
      eventClass: "transition",
      ...(stage === undefined ? {} : { stage }),
      ...(attempt === undefined ? {} : { attempt }),
      operationId: label,
      details: {
        label,
        snapshotId: snapshot.id,
        ...(snapshot.commit === undefined ? {} : { commit: snapshot.commit }),
      },
    });
    return snapshot;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function verifyAndDisposeAnalysis(
  dependencies: FactoryDependencies,
  analysis: AnalysisWorkspace,
): Promise<void> {
  let verificationError: unknown;
  try {
    await dependencies.workspace.verifyAnalysisWorkspace(analysis);
  } catch (error) {
    verificationError = error;
  }
  await dependencies.workspace.disposeAnalysisWorkspace(analysis);
  if (verificationError !== undefined) throw verificationError;
}

async function attachChangePackage(
  request: RunRequest,
  dependencies: FactoryDependencies,
  active: ActiveRun,
  operation: "review" | "re-review",
  fromTreeId: string,
  toTreeId: string,
  attemptId: string,
): Promise<void> {
  const id = `${safeArtifactPart(attemptId)}-change-package.json`;
  const content = await dependencies.workspace.createChangePackage(fromTreeId, toTreeId);
  const path = await dependencies.artifacts.attach(`evidence/${id}`, content);
  active.evidenceBundles.push({
    schemaVersion: 1,
    runId: request.runId,
    operationId: attemptId,
    originatingStage: "review",
    attemptId,
    provenance: "host-observed",
    treeId: toTreeId,
    workspaceSnapshotId: toTreeId,
    ...(active.suite === undefined ? {} : { suite: { version: active.suite.version, digest: active.suite.digest } }),
    changePackage: { id, path, mediaType: "application/json" },
    checks: [],
    decisions: [`Host-produced ${operation} change package from ${fromTreeId} to ${toTreeId}`],
    outstandingFindings: [...active.findings],
    reportReferences: [...active.reportReferences],
  });
}

function allCriteriaMet(request: RunRequest, report: StageReport): boolean {
  const verdicts = new Map(report.criteria.map((criterion) => [criterion.id, criterion.verdict]));
  return request.ticket.criteria.every((criterion) => verdicts.get(criterion.id) === "met");
}

async function finishFailure(
  request: RunRequest,
  dependencies: FactoryDependencies,
  events: RunEventWriter,
  active: ActiveRun,
  terminalReason: string,
  status: "failed" | "cancelled" = "failed",
  terminalReasonCode?: CorrectionFailureCode,
): Promise<RunOutcome> {
  const outcomeWithoutPath = {
    status,
    runId: request.runId,
    baseCommit: active.workspace.baseCommit,
    outputBranch: active.workspace.branch,
    attempts: active.attempts,
    criteria: active.reports.at(-1)?.criteria ?? [],
    repairRoundsUsed: active.repairRoundsUsed,
    findings: active.findings,
    ...(active.latestApprovedReviewTreeId === undefined
      ? {}
      : { approvedReviewTreeId: active.latestApprovedReviewTreeId }),
    terminalReason,
    ...(terminalReasonCode ? { terminalReasonCode } : {}),
  };
  await events.emit({
    type: "run-finalizing",
    eventClass: "transition",
    details: { status, reason: terminalReason, ...(terminalReasonCode ? { reasonCode: terminalReasonCode } : {}) },
  });
  await events.emit({
    type: "run-finished",
    eventClass: "transition",
    details: { status, reason: terminalReason, ...(terminalReasonCode ? { reasonCode: terminalReasonCode } : {}) },
  });
  const reportPath = await dependencies.artifacts.finalize(outcomeWithoutPath);
  return { ...outcomeWithoutPath, reportPath };
}

async function recordGate(
  events: RunEventWriter,
  gate: string,
  result: GateResult,
  stage?: Stage,
  attempt?: number,
): Promise<void> {
  await events.emit({
    type: gate === "preflight" ? "preflight-finished" : "gate-finished",
    eventClass: "transition",
    ...(stage === undefined ? {} : { stage }),
    ...(attempt === undefined ? {} : { attempt }),
    operationId: gate,
    details: {
      gate,
      passed: result.passed,
      checkCount: result.checks.length,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
      checks: result.checks,
    },
  });
}

async function recordAttemptReport(
  events: RunEventWriter,
  operation: AgentOperation,
  attempt: number,
  attemptId: string,
  outcome: AttemptOutcome,
  report: StageReport | undefined,
  reportProblems: readonly unknown[],
  accepted: boolean,
): Promise<void> {
  await events.emit({
    type: accepted ? "attempt-report-accepted" : "attempt-report-rejected",
    eventClass: "transition",
    stage: operation,
    attempt,
    operationId: attemptId,
    details: {
      status: outcome.status,
      sessionId: outcome.sessionId,
      evidence: outcome.evidence,
      ...(outcome.status !== "completed"
        ? { error: outcome.error }
        : report === undefined
          ? { reportProblems }
          : { report }),
    },
  });
}

async function retainReport(
  dependencies: FactoryDependencies,
  active: ActiveRun,
  report: StageReport,
  operation: AgentOperation,
): Promise<void> {
  const id = `report-${String(active.reportReferences.length + 1).padStart(3, "0")}-${safeArtifactPart(operation)}.json`;
  const path = await dependencies.artifacts.attach(`reports/${id}`, `${JSON.stringify(report, null, 2)}\n`);
  const summary = report.kind === "review" || report.kind === "re-review"
    ? `${report.kind} verdict: ${report.verdict}`
    : report.kind === "refactor"
      ? `refactor outcome: ${report.outcome}`
      : report.kind === "repair"
        ? `repair claims: ${report.claims.length}`
        : report.changedWork;
  active.reportReferences.push({
    operation,
    artifact: { id, path, mediaType: "application/json" },
    summary: summary.replace(/\s+/gu, " ").trim().slice(0, 500),
    unresolvedIssues: report.unresolvedIssues,
  });
}

function appendOperationalEvidence(
  active: ActiveRun,
  runId: string,
  operationId: string,
  originatingStage: Stage,
  decision: string,
): void {
  active.evidenceBundles.push({
    schemaVersion: 1,
    runId,
    operationId,
    originatingStage,
    provenance: "host-observed",
    checks: [],
    decisions: [decision],
    outstandingFindings: [...active.findings],
    reportReferences: [...active.reportReferences],
  });
}

async function captureGateEvidence(
  request: RunRequest,
  dependencies: FactoryDependencies,
  active: ActiveRun,
  operationId: string,
  gate: GateResult,
  originatingStage?: Stage,
  attemptId?: string,
): Promise<void> {
  const checks = await Promise.all(gate.checks.map(async (check, index) => {
    const content = await readFile(check.outputArtifact, "utf8");
    const id = `${safeArtifactPart(attemptId ?? operationId)}-${String(index + 1).padStart(2, "0")}-${safeArtifactPart(check.command)}.log`;
    const path = await dependencies.artifacts.attach(`evidence/${id}`, content);
    const reference: EvidenceArtifactReference = { id, path, mediaType: "text/plain" };
    return {
      command: check.command,
      outcome: check.exitCode === 0 ? "passed" as const : "failed" as const,
      exitCode: check.exitCode,
      ...(check.discoveredTests === undefined ? {} : { discoveredTests: check.discoveredTests }),
      ...(check.skippedTests === undefined ? {} : { skippedTests: check.skippedTests }),
      outputArtifact: reference,
      ...(check.exitCode === 0 ? {} : { decisiveExcerpt: decisiveExcerpt(content) }),
      treeId: check.treeId,
      ...(check.acceptanceDigest === undefined ? {} : { acceptanceDigest: check.acceptanceDigest }),
    };
  }));
  const treeIds = [...new Set(gate.checks.map(({ treeId }) => treeId))];
  active.evidenceBundles.push({
    schemaVersion: 1,
    runId: request.runId,
    operationId,
    ...(originatingStage === undefined ? {} : { originatingStage }),
    ...(attemptId === undefined ? {} : { attemptId }),
    provenance: "host-observed",
    ...(treeIds.length === 1 ? { treeId: treeIds[0] } : {}),
    ...(active.suite === undefined ? {} : { suite: { version: active.suite.version, digest: active.suite.digest } }),
    checks,
    ...(gate.diagnostics === undefined ? {} : { boundaryFailure: gate.diagnostics }),
    decisions: gate.reason === undefined ? [] : [gate.reason],
    outstandingFindings: [...active.findings],
    reportReferences: [...active.reportReferences],
  });
}

function decisiveExcerpt(content: string): string {
  const normalized = content.replaceAll("\0", "");
  return normalized.length <= 4_000 ? normalized : normalized.slice(-4_000);
}

function safeArtifactPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80) || "artifact";
}

function skillsFor(request: RunRequest, role: SkillRole): string[] {
  return [...new Set([...request.skills.shared, ...request.skills.byRole[role]])];
}
