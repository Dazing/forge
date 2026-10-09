import { z } from "zod";

export const stages = ["test-design", "implementation", "refactor", "review"] as const;
export type Stage = (typeof stages)[number];
export type TicketKind = "feature" | "bug" | "refactor";
export type AttemptTask = Stage | "pull-request";


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
    readonly provider: "vllm";
    readonly modelId: string;
    readonly endpoint: string;
  };
  readonly attemptTimeoutMs: number;
  readonly orchestrationTimeoutMs?: number;
  readonly standards: readonly string[];
}

export const stageReportSchema = z.object({
  status: z.enum(["completed", "blocked", "suspected-test-defect"]),
  stage: z.enum(stages),
  criteria: z.array(z.object({
    id: z.string().min(1),
    verdict: z.enum(["met", "unmet", "unverifiable"]),
    evidence: z.array(z.string().min(1)),
  })),
  evidence: z.array(z.string().min(1)),
  changedWork: z.string(),
  unresolvedIssues: z.array(z.string()),
});
export type StageReport = z.infer<typeof stageReportSchema>;
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
  readonly attempt: 1 | 2;
  readonly baseCommit: string;
  readonly snapshotId: string;
  readonly standards: readonly string[];
  readonly acceptanceSuite?: AcceptanceSuite;
  readonly priorReports: readonly StageReport[];
  readonly failureEvidence: readonly string[];
}

export interface AttemptRequest {
  readonly runId: string;
  readonly stage: Stage;
  readonly attempt: 1 | 2;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly deadline: number;
  readonly context: ContextBundle;
  readonly correction: boolean;
}
export interface PullRequestContext {
  readonly ticket: Ticket;
  readonly baseCommit: string;
  readonly snapshotId: string;
  readonly standards: readonly string[];
  readonly priorReports: readonly StageReport[];
  readonly verificationChecks: readonly CheckResult[];
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

export type PullRequestAttemptOutcome =
  | {
      readonly status: "completed";
      readonly attemptId: string;
      readonly sessionId: string;
      readonly report: PullRequestReport;
      readonly evidence: readonly string[];
    }
  | {
      readonly status: "execution-failure" | "timeout" | "cancelled";
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
      readonly status: "execution-failure" | "timeout" | "cancelled";
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

export interface GateResult {
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  readonly reason?: string;
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
  disposeAnalysisWorkspace(workspace: AnalysisWorkspace): Promise<void>;
  disposeExecutionResources(): Promise<void>;
}

export interface ExecutionBackendPort {
  runAttempt(request: AttemptRequest, signal: AbortSignal): Promise<AttemptOutcome>;
  runPullRequestAttempt(request: PullRequestAttemptRequest, signal: AbortSignal): Promise<PullRequestAttemptOutcome>;
  stopAttempt(attemptId: string): Promise<void>;
}

export interface VerificationPort {
  preflight(request: RunRequest, workspace: WorkspaceReference): Promise<GateResult>;
  validateCandidate(request: RunRequest, workspace: WorkspaceReference, report: StageReport): Promise<CandidateValidation>;
  freezeSuite(validation: CandidateValidation): Promise<AcceptanceSuite>;
  runChecks(stage: Stage, workspace: WorkspaceReference, suite: AcceptanceSuite): Promise<GateResult>;
  captureProductionIdentity(workspace: WorkspaceReference): Promise<string>;
  validateCorrection(request: RunRequest, workspace: WorkspaceReference, report: StageReport, current: AcceptanceSuite, productionIdentity: string): Promise<CandidateValidation>;
  integrateSuite(workspace: WorkspaceReference, suite: AcceptanceSuite): Promise<void>;
  verifyFinalCandidate(workspace: WorkspaceReference, suite: AcceptanceSuite): Promise<GateResult>;
}

export interface ArtifactEvent {
  readonly type: string;
  readonly runId: string;
  readonly stage?: AttemptTask;
  readonly attempt?: number;
  readonly details: Readonly<Record<string, unknown>>;
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
  readonly terminalReason: string;
  readonly pullRequestPath?: string;
  readonly reportPath: string;
}
