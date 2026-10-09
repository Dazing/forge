import { z } from "zod";

export const stages = ["test-design", "implementation", "refactor", "review"] as const;
export type Stage = (typeof stages)[number];
export const agentOperations = [...stages, "acceptance-correction", "repair", "re-review"] as const;
export type AgentOperation = (typeof agentOperations)[number];
export type TicketKind = "feature" | "bug" | "refactor";
export type AttemptTask = AgentOperation | "pull-request";
export type SkillRole = AgentOperation | "pull-request";

export interface SkillConfiguration {
  readonly shared: readonly string[];
  readonly byRole: Readonly<Record<SkillRole, readonly string[]>>;
}


export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
}

export interface Ticket {
  readonly path: string;
  readonly markdown: string;
  readonly digest: string;
  readonly kind: TicketKind;
  readonly criteria: readonly AcceptanceCriterion[];
}

export interface RunRequest {
  readonly runId: string;
  readonly ticket: Ticket;
  readonly repository: {
    readonly sourcePath: string;
    readonly baseRef: string;
    readonly outputBranch: string;
    readonly profilePath: string;
  };
  readonly model: {
    readonly provider: "openai-subscription";
    readonly modelId: string;
  };
  readonly attemptTimeoutMs: number;
  readonly orchestrationTimeoutMs?: number;
  readonly skills: SkillConfiguration;
}

const criterionResultSchema = z.object({
  id: z.string().min(1),
  verdict: z.enum(["met", "unmet", "unverifiable"]),
  evidence: z.array(z.string().min(1)),
}).strict();

export const findingSubmissionSchema = z.object({
  localKey: z.string().min(1),
  category: z.enum(["requirement", "correctness", "security", "maintainability"]),
  severity: z.enum(["blocking", "advisory"]),
  criterionId: z.string().min(1).optional(),
  repositoryRule: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  affectedContract: z.string().min(1).optional(),
  scenario: z.string().min(1),
  evidenceReferences: z.array(z.string().min(1)).min(1),
  expected: z.string().min(1).optional(),
  observed: z.string().min(1).optional(),
}).strict().refine(
  (finding) => finding.criterionId !== undefined || finding.repositoryRule !== undefined,
  "a finding must reference a ticket criterion or repository rule",
);
export type FindingSubmission = z.infer<typeof findingSubmissionSchema>;

const reportBase = {
  status: z.enum(["completed", "blocked", "suspected-test-defect"]),
  criteria: z.array(criterionResultSchema),
  evidence: z.array(z.string().min(1)),
  unresolvedIssues: z.array(z.string()),
};

const authoringReportSchema = z.object({
  kind: z.literal("authoring"),
  ...reportBase,
  stage: z.enum(["test-design", "implementation"]),
  operation: z.enum(["test-design", "implementation", "acceptance-correction"]),
  changedWork: z.string(),
}).strict().superRefine((report, context) => {
  const expectedStage = report.operation === "acceptance-correction" ? "test-design" : report.operation;
  if (report.stage !== expectedStage) {
    context.addIssue({ code: "custom", path: ["stage"], message: `operation ${report.operation} requires stage ${expectedStage}` });
  }
});

const refactorReportSchema = z.object({
  kind: z.literal("refactor"),
  ...reportBase,
  stage: z.literal("refactor"),
  operation: z.literal("refactor"),
  changedWork: z.string(),
  outcome: z.enum(["changed", "no-op", "repair-required"]),
  findings: z.array(findingSubmissionSchema),
}).strict();

const reviewReportSchema = z.object({
  kind: z.literal("review"),
  ...reportBase,
  stage: z.literal("review"),
  operation: z.literal("review"),
  contractCompliance: z.enum(["approved", "changes-required", "unverifiable"]),
  implementationQuality: z.enum(["approved", "changes-required", "unverifiable"]),
  verdict: z.enum(["approved", "changes-required", "unverifiable"]),
  findings: z.array(findingSubmissionSchema),
}).strict();

const repairReportSchema = z.object({
  kind: z.literal("repair"),
  ...reportBase,
  operation: z.literal("repair"),
  stage: z.literal("implementation"),
  claims: z.array(z.object({
    findingId: z.string().min(1),
    claim: z.enum(["addressed", "disputed"]),
    evidence: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
  changedWork: z.string(),
}).strict();

const reReviewReportSchema = z.object({
  kind: z.literal("re-review"),
  ...reportBase,
  operation: z.literal("re-review"),
  stage: z.literal("review"),
  verdict: z.enum(["approved", "changes-required", "unverifiable"]),
  findingVerdicts: z.array(z.object({
    findingId: z.string().min(1),
    verdict: z.enum(["resolved", "dismissed", "unresolved"]),
    evidence: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
  newFindings: z.array(findingSubmissionSchema),
}).strict();

export const agentReportSchema = z.discriminatedUnion("kind", [
  authoringReportSchema,
  refactorReportSchema,
  reviewReportSchema,
  repairReportSchema,
  reReviewReportSchema,
]);
export const stageReportSchema = agentReportSchema;
export type StageReport = z.infer<typeof agentReportSchema>;

export const candidateManifestExpectationSchema = z.object({
  criteria: z.array(z.string().min(1)).min(1),
  target: z.string().min(1),
  provenance: z.object({
    kind: z.enum(["ticket", "repository-contract", "assumption"]),
    source: z.string().min(1),
    rationale: z.string().min(1),
  }).strict(),
  distinguishingInput: z.string().min(1),
  expectedResult: z.string().min(1),
  rejects: z.string().min(1),
  materialAlternative: z.boolean(),
  ambiguity: z.enum(["resolved", "unresolved"]),
  derived: z.boolean(),
  derivation: z.object({
    setupState: z.string().min(1),
    transition: z.string().min(1),
    predicate: z.string().min(1),
  }).strict().optional(),
}).strict().superRefine((expectation, context) => {
  if (expectation.derived && expectation.derivation === undefined) {
    context.addIssue({
      code: "custom",
      path: ["derivation"],
      message: "derived expectations require setup state, transition, and predicate",
    });
  }
});
export const pullRequestReportSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  title: z.string().trim().min(1),
  summary: z.array(z.string().trim().min(1)).min(1).max(5),
  eli5: z.string().trim().min(1),
  playByPlay: z.array(z.object({
    explanation: z.string().trim().min(1),
    references: z.array(z.string().trim().min(1)),
  })).min(1),
  evidence: z.array(z.string().trim().min(1)),
  unresolvedIssues: z.array(z.string()),
});
export type PullRequestReport = z.infer<typeof pullRequestReportSchema>;


export interface ContextBundle {
  readonly ticket: Ticket;
  readonly stage: Stage;
  readonly operation: AgentOperation;
  readonly attempt: 1 | 2;
  readonly baseCommit: string;
  readonly snapshotId: string;
  readonly standards: readonly string[];
  readonly acceptanceSuite?: AcceptanceSuite;
  readonly reportReferences: readonly ReportReference[];
  readonly evidenceBundles: readonly HostEvidenceBundle[];
  readonly authorizedFindings?: readonly Finding[];
  readonly repairRound?: 1 | 2;
  readonly reviewedTreeId?: string;
}

export interface AttemptRequest {
  readonly runId: string;
  readonly stage: Stage;
  readonly operation: AgentOperation;
  readonly attempt: 1 | 2;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly deadline: number;
  readonly context: ContextBundle;
  readonly candidateReadonly: boolean;
}
export interface PullRequestContext {
  readonly ticket: Ticket;
  readonly baseCommit: string;
  readonly snapshotId: string;
  readonly standards: readonly string[];
  readonly reportReferences: readonly ReportReference[];
  readonly evidenceBundles: readonly HostEvidenceBundle[];
}

export interface PullRequestAttemptRequest {
  readonly runId: string;
  readonly attempt: 1 | 2;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly deadline: number;
  readonly context: PullRequestContext;
}

export type AttemptFailureStatus = "execution-failure" | "timeout" | "cancelled" | "shutdown-stalled";

export type PullRequestAttemptOutcome =
  | {
      readonly status: "completed";
      readonly attemptId: string;
      readonly sessionId: string;
      readonly report: PullRequestReport;
      readonly evidence: readonly string[];
    }
  | {
      readonly status: AttemptFailureStatus;
      readonly attemptId: string;
      readonly sessionId: string;
      readonly error: string;
      readonly evidence: readonly string[];
    };

export type AttemptOutcome =
  | {
      readonly status: "completed";
      readonly attemptId: string;
      readonly sessionId: string;
      readonly report: StageReport;
      readonly evidence: readonly string[];
    }
  | {
      readonly status: AttemptFailureStatus;
      readonly attemptId: string;
      readonly sessionId: string;
      readonly error: string;
      readonly evidence: readonly string[];
    };

export interface CheckResult {
  readonly command: string;
  readonly exitCode: number;
  readonly discoveredTests?: number;
  readonly skippedTests?: number;
  readonly outputArtifact: string;
  readonly treeId: string;
  readonly acceptanceDigest?: string;
}

export interface EvidenceArtifactReference {
  readonly id: string;
  readonly path: string;
  readonly mediaType: "text/plain" | "application/json";
}

export interface EvidenceCheck {
  readonly command: string;
  readonly outcome: "passed" | "failed" | "unavailable";
  readonly exitCode?: number;
  readonly discoveredTests?: number;
  readonly skippedTests?: number;
  readonly outputArtifact?: EvidenceArtifactReference;
  readonly decisiveExcerpt?: string;
  readonly treeId?: string;
  readonly acceptanceDigest?: string;
}

export interface ProtectedContentIdentity {
  readonly digest: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

export type CorrectionFailureCode =
  | "correction-boundary-violation"
  | "correction-rejected"
  | "correction-execution-failed"
  | "correction-budget-unavailable";

export interface CorrectionBoundaryDiagnostics {
  readonly policy: "protected-workspace-content";
  readonly exclusions: readonly string[];
  readonly beforeIdentity: string;
  readonly afterIdentity: string;
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly binding: {
    readonly runId: string;
    readonly ticketDigest: string;
    readonly baseCommit: string;
    readonly suiteVersion: string;
    readonly suiteDigest: string;
  };
}

export type FindingLifecycle = "open" | "repair-claimed" | "verified-resolved" | "dismissed";

export interface Finding {
  readonly id: string;
  readonly originatingOperation: AgentOperation;
  readonly reviewedTreeId: string;
  readonly category: FindingSubmission["category"];
  readonly severity: FindingSubmission["severity"];
  readonly criterionId?: string;
  readonly repositoryRule?: string;
  readonly location?: string;
  readonly affectedContract?: string;
  readonly scenario: string;
  readonly evidenceReferences: readonly string[];
  readonly expected?: string;
  readonly observed?: string;
  readonly lifecycle: FindingLifecycle;
}

export interface ReportReference {
  readonly operation: AgentOperation;
  readonly artifact: EvidenceArtifactReference;
  readonly summary: string;
  readonly unresolvedIssues: readonly string[];
}

export interface HostEvidenceBundle {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly operationId: string;
  readonly originatingStage?: Stage;
  readonly attemptId?: string;
  readonly provenance: "host-observed";
  readonly treeId?: string;
  readonly workspaceSnapshotId?: string;
  readonly suite?: { readonly version: string; readonly digest: string };
  readonly materializedPath?: string;
  readonly changePackage?: EvidenceArtifactReference;
  readonly checks: readonly EvidenceCheck[];
  readonly boundaryFailure?: CorrectionBoundaryDiagnostics;
  readonly decisions: readonly string[];
  readonly outstandingFindings: readonly Finding[];
  readonly reportReferences: readonly ReportReference[];
}

export interface GateResult {
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  readonly reason?: string;
  readonly reasonCode?: CorrectionFailureCode;
  readonly diagnostics?: CorrectionBoundaryDiagnostics;
}

export interface CandidateValidation extends GateResult {
  readonly accepted: boolean;
  readonly suiteVersion?: string;
  readonly mapping?: readonly { readonly criterionId: string; readonly tests: readonly string[] }[];
}

export interface AcceptanceSuite {
  readonly version: string;
  readonly digest: string;
  readonly path: string;
}

export interface WorkspaceReference {
  readonly path: string;
  readonly baseCommit: string;
  readonly branch: string;
}

export interface Snapshot {
  readonly id: string;
  readonly commit?: string;
}

export interface PublishedBranch {
  readonly branch: string;
  readonly commit: string;
}
export interface AnalysisWorkspace {
  readonly path: string;
  readonly treeId: string;
}


export interface GitWorkspacePort {
  prepare(request: RunRequest): Promise<WorkspaceReference>;
  snapshot(label: string): Promise<Snapshot>;
  publishBranch(expectedBaseCommit: string): Promise<PublishedBranch>;
  createAnalysisWorkspace(expectedTreeId: string): Promise<AnalysisWorkspace>;
  createChangePackage(fromTreeId: string, toTreeId: string): Promise<string>;
  verifyAnalysisWorkspace(workspace: AnalysisWorkspace): Promise<void>;
  disposeAnalysisWorkspace(workspace: AnalysisWorkspace): Promise<void>;
  disposeExecutionResources(): Promise<void>;
}

export type AttemptEventObserver = (event: RunEventDraft) => Promise<void>;

export interface ExecutionBackendPort {
  runAttempt(
    request: AttemptRequest,
    signal: AbortSignal,
    observe?: AttemptEventObserver,
  ): Promise<AttemptOutcome>;
  runPullRequestAttempt(
    request: PullRequestAttemptRequest,
    signal: AbortSignal,
    observe?: AttemptEventObserver,
  ): Promise<PullRequestAttemptOutcome>;
  stopAttempt(attemptId: string): Promise<void>;
}

export interface VerificationPort {
  preflight(request: RunRequest, workspace: WorkspaceReference): Promise<GateResult>;
  validateCandidate(request: RunRequest, workspace: WorkspaceReference, report: StageReport): Promise<CandidateValidation>;
  freezeSuite(validation: CandidateValidation): Promise<AcceptanceSuite>;
  runChecks(stage: Stage, workspace: WorkspaceReference, suite: AcceptanceSuite): Promise<GateResult>;
  captureProtectedContentIdentity(workspace: WorkspaceReference): Promise<ProtectedContentIdentity>;
  validateCorrection(request: RunRequest, workspace: WorkspaceReference, report: StageReport, current: AcceptanceSuite, protectedIdentity: ProtectedContentIdentity): Promise<CandidateValidation>;
  integrateSuite(workspace: WorkspaceReference, suite: AcceptanceSuite): Promise<void>;
  verifyFinalCandidate(workspace: WorkspaceReference, suite: AcceptanceSuite): Promise<GateResult>;
}

export const runEventTypes = [
  "run-preparing",
  "run-started",
  "preflight-started",
  "preflight-finished",
  "workspace-snapshot-started",
  "workspace-snapshot-finished",
  "attempt-preparing",
  "attempt-transcript-ready",
  "attempt-runner-entered",
  "attempt-agent-activity-started",
  "attempt-status",
  "attempt-deadline-reached",
  "attempt-abort-requested",
  "attempt-shutdown-confirmed",
  "attempt-shutdown-stalled",
  "attempt-runner-finished",
  "attempt-report-accepted",
  "attempt-report-rejected",
  "gate-started",
  "gate-finished",
  "stage-finished",
  "analysis-workspace-started",
  "analysis-workspace-finished",
  "analysis-workspace-ready",
  "acceptance-suite-corrected",
  "pull-request-drafted",
  "publication-started",
  "publication-finished",
  "run-finalizing",
  "run-finished",
] as const;
export type RunEventType = (typeof runEventTypes)[number];

export interface RunEventDraft {
  readonly type: RunEventType;
  readonly eventClass: "transition" | "observation";
  readonly stage?: AttemptTask;
  readonly attempt?: number;
  readonly operationId?: string;
  readonly deadlineAt?: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ArtifactEvent extends RunEventDraft {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly runId: string;
  readonly occurredAt: string;
  readonly runElapsedMs: number;
}

export interface RunArtifactsPort {
  record(event: ArtifactEvent): Promise<void>;
  attach(name: string, content: string | Uint8Array): Promise<string>;
  finalize(outcome: Omit<RunOutcome, "reportPath">): Promise<string>;
}

export interface FactoryDependencies {
  readonly workspace: GitWorkspacePort;
  readonly backend: ExecutionBackendPort;
  readonly verification: VerificationPort;
  readonly artifacts: RunArtifactsPort;
  readonly now?: () => number;
  readonly progress?: (event: ArtifactEvent) => void;
}

export interface StageAttemptRecord {
  readonly stage: AttemptTask;
  readonly attempt: number;
  readonly sessionId: string;
  readonly status: AttemptOutcome["status"] | "rejected";
  readonly evidence: readonly string[];
}

export interface RunOutcome {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly runId: string;
  readonly baseCommit?: string;
  readonly outputBranch: string;
  readonly finalCommit?: string;
  readonly attempts: readonly StageAttemptRecord[];
  readonly criteria: readonly StageReport["criteria"][number][];
  readonly repairRoundsUsed: number;
  readonly findings: readonly Finding[];
  readonly approvedReviewTreeId?: string;
  readonly terminalReason: string;
  readonly terminalReasonCode?: CorrectionFailureCode;
  readonly pullRequestPath?: string;
  readonly reportPath: string;
}
