import { createHash } from "node:crypto";
import { appendFile, chown, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  buildPullRequestPrompt,
  buildStagePrompt,
  pullRequestReportSchema,
  stageReportSchema,
  type AttemptOutcome,
  type AttemptRequest,
  type AttemptEventObserver,
  type AttemptFailureStatus,
  type ExecutionBackendPort,
  type EvidenceArtifactReference,
  type HostEvidenceBundle,
  type PullRequestAttemptOutcome,
  type PullRequestAttemptRequest,
  type PullRequestReport,
  type StageReport,
} from "@factory/core";
import { SandcastleRunner } from "./sandcastle-runner.js";

const SANDBOX_INPUTS_PATH = "/home/agent/factory-inputs";
const OPENCODE_SKILLS_PATH = "/home/agent/.config/opencode/skills";
const SANDBOX_SCRATCH_PATH = "/home/agent/factory-scratch";
const SANDBOX_EVIDENCE_PATH = `${SANDBOX_INPUTS_PATH}/evidence`;
const SANDBOX_EVIDENCE_BUNDLES_PATH = `${SANDBOX_INPUTS_PATH}/evidence-bundles`;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ExecutionBackendConfig {
  readonly imageName: string;
  readonly authFile: string;
  readonly modelId: string;
  readonly artifactsPath: string;
  readonly network?: string;
  readonly containerUid?: number;
  readonly containerGid?: number;
  readonly idleTimeoutSeconds?: number;
  readonly attemptShutdownGraceMs?: number;
  readonly statusIntervalMs?: number;
}

export interface ReadonlyMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly: true;
}

export interface ScratchMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly: false;
}

export interface RunnerInvocation {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly kind: "stage" | "pull-request";
  readonly prompt: string;
  readonly transcriptPath: string;
  readonly branchStrategy: {
    readonly type: "head";
  };
  readonly mounts: readonly ReadonlyMount[];
  readonly scratch: ScratchMount;
  readonly signal: AbortSignal;
  readonly onAgentActivity?: () => void;
}

export interface RunnerResult {
  readonly report: unknown;
  readonly runtimeSessionId?: string;
  readonly evidence: readonly string[];
}

export interface SandcastleAttemptRunner {
  run(invocation: RunnerInvocation): Promise<RunnerResult>;
  /** Real runtimes must confirm no live worker still has this mount before host cleanup. */
  canRemoveScratch?(scratch: ScratchMount): Promise<boolean>;
}

interface ActiveAttempt {
  readonly completion: Promise<void>;
  readonly requestStop: (cause: Exclude<AbortCause, undefined>, reason?: unknown) => void;
}

type AbortCause = "cancelled" | "timeout" | undefined;

class AttemptTimeoutError extends Error {
  constructor(attemptId: string) {
    super(`Attempt ${attemptId} reached its deadline.`);
    this.name = "AttemptTimeoutError";
  }
}

class AttemptStoppedError extends Error {
  constructor(attemptId: string) {
    super(`Attempt ${attemptId} was stopped.`);
    this.name = "AttemptStoppedError";
  }
}
type AgentAttemptRequest = AttemptRequest | PullRequestAttemptRequest;
type AgentAttemptOutcome = AttemptOutcome | PullRequestAttemptOutcome;


export class ExecutionBackend implements ExecutionBackendPort {
  readonly #activeAttempts = new Map<string, ActiveAttempt>();
  readonly #seenAttemptIds = new Set<string>();
  readonly #seenSessionIds = new Set<string>();
  readonly #seenRuntimeSessionIds = new Set<string>();
  readonly #config: ExecutionBackendConfig;
  readonly #runner: SandcastleAttemptRunner;

  constructor(config: ExecutionBackendConfig, runner?: SandcastleAttemptRunner) {
    this.#config = validateConfig(config);
    this.#runner = runner ?? new SandcastleRunner(this.#config);
  }

  runAttempt(
    request: AttemptRequest,
    signal: AbortSignal,
    observe?: AttemptEventObserver,
  ): Promise<AttemptOutcome> {
    return this.#run(request, signal, "stage", observe);
  }

  runPullRequestAttempt(
    request: PullRequestAttemptRequest,
    signal: AbortSignal,
    observe?: AttemptEventObserver,
  ): Promise<PullRequestAttemptOutcome> {
    return this.#run(request, signal, "pull-request", observe);
  }

  async #run(
    request: AttemptRequest,
    signal: AbortSignal,
    kind: "stage",
    observe?: AttemptEventObserver,
  ): Promise<AttemptOutcome>;
  async #run(
    request: PullRequestAttemptRequest,
    signal: AbortSignal,
    kind: "pull-request",
    observe?: AttemptEventObserver,
  ): Promise<PullRequestAttemptOutcome>;
  async #run(
    request: AgentAttemptRequest,
    signal: AbortSignal,
    kind: RunnerInvocation["kind"],
    observe?: AttemptEventObserver,
  ): Promise<AgentAttemptOutcome> {
    const identityError = this.#claimIdentity(request);
    if (identityError !== undefined) {
      return executionFailure(request, identityError, []);
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    const stopRequested = Promise.withResolvers<{ cause: Exclude<AbortCause, undefined>; reason: unknown }>();
    let stopCause: Exclude<AbortCause, undefined> | undefined;
    let stalled = false;
    let lifecycle: Promise<void> = Promise.resolve();
    const emit: AttemptEventObserver = (event) => {
      const operation = async () => observe?.(event);
      lifecycle = lifecycle.then(operation, operation);
      return lifecycle;
    };
    const requestStop = (cause: Exclude<AbortCause, undefined>, reason?: unknown) => {
      if (stopCause !== undefined) return;
      stopCause = cause;
      const resolvedReason = reason ?? (cause === "timeout"
        ? new AttemptTimeoutError(request.attemptId)
        : new AttemptStoppedError(request.attemptId));
      controller.abort(resolvedReason);
      stopRequested.resolve({ cause, reason: resolvedReason });
    };
    const activeAttempt: ActiveAttempt = {
      completion: completion.promise,
      requestStop,
    };
    this.#activeAttempts.set(request.attemptId, activeAttempt);

    const cancelFromCaller = () => requestStop("cancelled", signal.reason);
    signal.addEventListener("abort", cancelFromCaller, { once: true });
    if (signal.aborted) cancelFromCaller();

    const remainingMs = Math.max(0, request.deadline - Date.now());
    const deadlineTimer = setTimeout(
      () => requestStop("timeout", new AttemptTimeoutError(request.attemptId)),
      Math.min(remainingMs, 2_147_483_647),
    );
    deadlineTimer.unref();
    let statusTimer: NodeJS.Timeout | undefined;
    let lastAgentActivityAt: string | undefined;
    let activityStarted = false;
    const transcript = transcriptPath(this.#config.artifactsPath, request.attemptId);
    let scratch: ScratchMount | undefined;
    let runnerStopped = true;
    let initialAuthSecrets: string[] = [];

    try {
      validateRequest(request, kind);
      const baseInvocation = await this.#createInvocation(request, controller.signal, kind);
      initialAuthSecrets = collectSecretStrings(JSON.parse(await readFile(this.#config.authFile, "utf8")));
      scratch = baseInvocation.scratch;
      await emit({
        type: "attempt-transcript-ready",
        eventClass: "transition",
        operationId: request.attemptId,
        details: { transcriptPath: baseInvocation.transcriptPath },
      });
      const onAgentActivity = () => {
        lastAgentActivityAt = new Date().toISOString();
        if (activityStarted) return;
        activityStarted = true;
        void emit({
          type: "attempt-agent-activity-started",
          eventClass: "transition",
          operationId: request.attemptId,
          details: { firstActivityAt: lastAgentActivityAt },
        });
      };
      const invocation: RunnerInvocation = { ...baseInvocation, onAgentActivity };
      await emit({
        type: "attempt-runner-entered",
        eventClass: "transition",
        operationId: request.attemptId,
        details: { runner: "sandcastle", sandbox: "docker" },
      });
      statusTimer = setInterval(() => {
        void this.#emitStatus(emit, request, transcript, startedAt, lastAgentActivityAt);
      }, this.#config.statusIntervalMs ?? 30_000);
      statusTimer.unref();

      if (stopCause !== undefined) {
        await this.#emitStopEvents(emit, request, stopCause);
        await emit({
          type: "attempt-shutdown-confirmed",
          eventClass: "transition",
          operationId: request.attemptId,
          details: { cause: stopCause, settlementMs: 0, runnerStarted: false },
        });
        const outcome = abortedOutcome(request, stopCause, transcript);
        await emitRunnerFinished(emit, request.attemptId, outcome.status, false);
        return outcome;
      }

      runnerStopped = false;
      const runnerSettled = Promise.resolve().then(() => this.#runner.run(invocation)).then(
        (result) => {
          runnerStopped = true;
          return { type: "result" as const, result };
        },
        (error: unknown) => {
          runnerStopped = true;
          return { type: "error" as const, error };
        },
      );
      const first = await Promise.race([
        runnerSettled,
        stopRequested.promise.then((stop) => ({ type: "stop" as const, stop })),
      ]);

      if (first.type === "stop") {
        const shutdownStartedAt = Date.now();
        await this.#emitStopEvents(emit, request, first.stop.cause);
        const settled = await Promise.race([
          runnerSettled.then((result) => ({ type: "settled" as const, result })),
          delay(this.#config.attemptShutdownGraceMs ?? 10_000).then(() => ({ type: "stalled" as const })),
        ]);
        if (settled.type === "stalled") {
          stalled = true;
          await emit({
            type: "attempt-shutdown-stalled",
            eventClass: "transition",
            operationId: request.attemptId,
            details: {
              cause: first.stop.cause,
              shutdownGraceMs: this.#config.attemptShutdownGraceMs ?? 10_000,
            },
          });
          const outcome = shutdownStalledOutcome(request, transcript);
          await emitRunnerFinished(emit, request.attemptId, outcome.status, false);
          return outcome;
        }
        await emit({
          type: "attempt-shutdown-confirmed",
          eventClass: "transition",
          operationId: request.attemptId,
          details: {
            cause: first.stop.cause,
            settlementMs: Date.now() - shutdownStartedAt,
            runnerStarted: true,
          },
        });
        const outcome = abortedOutcome(request, first.stop.cause, transcript);
        await emitRunnerFinished(emit, request.attemptId, outcome.status, false);
        return outcome;
      }

      if (first.type === "error") throw first.error;
      const result = first.result;
      let outcome: AgentAttemptOutcome;
      if (result.runtimeSessionId === undefined || result.runtimeSessionId.length === 0) {
        outcome = executionFailure(
          request,
          `Attempt ${request.attemptId} did not expose a new OpenCode runtime session identity.`,
          result.evidence,
        );
      } else if (this.#seenRuntimeSessionIds.has(result.runtimeSessionId)) {
        outcome = executionFailure(
          request,
          `Attempt ${request.attemptId} reused OpenCode runtime session ${result.runtimeSessionId}.`,
          result.evidence,
        );
      } else {
        this.#seenRuntimeSessionIds.add(result.runtimeSessionId);
        outcome = parseRunnerOutcome(request, kind, result.report, result.evidence);
      }
      await lifecycle;
      await emitRunnerFinished(emit, request.attemptId, outcome.status, result.runtimeSessionId !== undefined);
      return outcome;
    } catch (error) {
      const outcome = stopCause === undefined
        ? executionFailure(request, formatExecutionError(request.attemptId, error), [transcript])
        : abortedOutcome(request, stopCause, transcript);
      await emitRunnerFinished(emit, request.attemptId, outcome.status, false).catch(() => undefined);
      return outcome;
    } finally {
      clearTimeout(deadlineTimer);
      clearInterval(statusTimer);
      signal.removeEventListener("abort", cancelFromCaller);
      if (!stalled && runnerStopped) {
        if (scratch !== undefined) {
          const released = this.#runner.canRemoveScratch === undefined
            || await this.#runner.canRemoveScratch(scratch).catch(() => false);
          if (released) {
            // Only the writable child is mounted; its host-owned parent cannot be replaced by the worker.
            await rm(dirname(scratch.hostPath), { recursive: true, force: true }).catch(async (error: unknown) => {
              await appendFile(
                transcript,
                `\n[orchestrator] scratch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
                { encoding: "utf8", mode: 0o600 },
              ).catch(() => undefined);
            });
          } else {
            await appendFile(
              transcript,
              `\n[orchestrator] scratch retained at ${scratch.hostPath}: runtime mount release could not be confirmed.\n`,
              { encoding: "utf8", mode: 0o600 },
            ).catch(() => undefined);
          }
        }
        await lifecycle.catch(() => undefined);
        await redactTranscript(transcript, this.#config, initialAuthSecrets).catch(async (error: unknown) => {
          await appendFile(
            transcript,
            `\\n[orchestrator] transcript redaction failed: ${error instanceof Error ? error.message : String(error)}\\n`,
            { encoding: "utf8", mode: 0o600 },
          ).catch(() => undefined);
        });
        if (this.#activeAttempts.get(request.attemptId) === activeAttempt) {
          this.#activeAttempts.delete(request.attemptId);
        }
        completion.resolve();
      }
    }
  }

  async stopAttempt(attemptId: string): Promise<void> {
    const activeAttempt = this.#activeAttempts.get(attemptId);
    if (activeAttempt === undefined) return;
    activeAttempt.requestStop("cancelled", new AttemptStoppedError(attemptId));
    await activeAttempt.completion;
  }

  async #emitStatus(
    emit: AttemptEventObserver,
    request: AgentAttemptRequest,
    transcript: string,
    startedAt: number,
    lastAgentActivityAt: string | undefined,
  ): Promise<void> {
    const now = Date.now();
    const metadata = await stat(transcript).catch(() => undefined);
    await emit({
      type: "attempt-status",
      eventClass: "observation",
      operationId: request.attemptId,
      details: {
        elapsedMs: Math.max(0, now - startedAt),
        remainingMs: Math.max(0, request.deadline - now),
        transcriptBytes: metadata?.size ?? 0,
        transcriptModifiedAt: metadata?.mtime.toISOString(),
        ...(lastAgentActivityAt === undefined ? {} : { lastAgentActivityAt }),
      },
    });
  }

  async #emitStopEvents(
    emit: AttemptEventObserver,
    request: AgentAttemptRequest,
    cause: Exclude<AbortCause, undefined>,
  ): Promise<void> {
    if (cause === "timeout") {
      await emit({
        type: "attempt-deadline-reached",
        eventClass: "transition",
        operationId: request.attemptId,
        details: { deadline: request.deadline },
      });
    }
    const shutdownGraceMs = this.#config.attemptShutdownGraceMs ?? 10_000;
    await emit({
      type: "attempt-abort-requested",
      eventClass: "transition",
      operationId: request.attemptId,
      deadlineAt: new Date(Date.now() + shutdownGraceMs).toISOString(),
      details: { cause, shutdownGraceMs },
    });
  }

  #claimIdentity(request: AgentAttemptRequest): string | undefined {
    if (this.#seenAttemptIds.has(request.attemptId)) {
      return `Attempt identity ${request.attemptId} has already been used.`;
    }
    if (this.#seenSessionIds.has(request.sessionId)) {
      return `Session identity ${request.sessionId} has already been used.`;
    }

    this.#seenAttemptIds.add(request.attemptId);
    this.#seenSessionIds.add(request.sessionId);
    return undefined;
  }

  async #createInvocation(
    request: AgentAttemptRequest,
    signal: AbortSignal,
    kind: RunnerInvocation["kind"],
  ): Promise<RunnerInvocation> {
    const workspacePath = await realpath(request.workspacePath);
    const artifactsPath = await ensureDirectory(this.#config.artifactsPath);
    assertOutsideWorkspace(workspacePath, artifactsPath, "Artifact directory");

    const mounts: ReadonlyMount[] = [];
    const skillNames = new Set<string>();
    for (const [index, standardsPath] of request.context.standards.entries()) {
      const hostPath = await realpath(standardsPath);
      assertOutsideWorkspace(workspacePath, hostPath, `Skill input ${index + 1}`);
      const skillName = basename(hostPath);
      if (!SKILL_NAME_PATTERN.test(skillName)) {
        throw new Error(`Skill input ${index + 1} directory name "${skillName}" is not a valid OpenCode skill name.`);
      }
      if (skillNames.has(skillName)) {
        throw new Error(`OpenCode skill name "${skillName}" is configured more than once.`);
      }
      const skillFilePath = await realpath(join(hostPath, "SKILL.md"));
      if (relative(hostPath, skillFilePath) !== "SKILL.md") {
        throw new Error(`Skill input ${index + 1} must contain its own SKILL.md file.`);
      }
      skillNames.add(skillName);
      mounts.push({
        hostPath,
        sandboxPath: `${OPENCODE_SKILLS_PATH}/${skillName}`,
        readonly: true,
      });
    }

    let acceptanceSuitePath: string | undefined;
    if ("acceptanceSuite" in request.context && request.context.acceptanceSuite !== undefined) {
      acceptanceSuitePath = await realpath(request.context.acceptanceSuite.path);
      assertOutsideWorkspace(workspacePath, acceptanceSuitePath, "Authoritative acceptance suite");
      mounts.push({
        hostPath: acceptanceSuitePath,
        sandboxPath: `${SANDBOX_INPUTS_PATH}/acceptance`,
        readonly: true,
      });
    }

    const evidencePaths = new Map<string, string>();
    const mountedEvidenceIds = new Set<string>();
    for (const artifact of evidenceArtifacts(request.context.evidenceBundles)) {
      if (!EVIDENCE_ID_PATTERN.test(artifact.id) || artifact.id === "." || artifact.id === "..") {
        throw new Error(`Evidence artifact identifier ${JSON.stringify(artifact.id)} is invalid.`);
      }
      const hostPath = await realpath(artifact.path);
      assertOutsideWorkspace(workspacePath, hostPath, `Evidence artifact ${artifact.id}`);
      if (!containsPath(artifactsPath, hostPath)) {
        throw new Error(`Evidence artifact ${artifact.id} must be inside the host-owned artifact export directory.`);
      }
      if (!(await stat(hostPath)).isFile()) {
        throw new Error(`Evidence artifact ${artifact.id} must be a regular file.`);
      }
      const sandboxPath = `${SANDBOX_EVIDENCE_PATH}/${artifact.id}`;
      const existingPath = evidencePaths.get(artifact.path);
      if (existingPath !== undefined) continue;
      if (mountedEvidenceIds.has(artifact.id)) {
        throw new Error(`Evidence artifact identifier ${artifact.id} is configured more than once.`);
      }
      mountedEvidenceIds.add(artifact.id);
      evidencePaths.set(artifact.path, sandboxPath);
      mounts.push({ hostPath, sandboxPath, readonly: true });
    }
    const rewrittenEvidenceBundles = rewriteEvidenceBundles(request.context.evidenceBundles, evidencePaths);
    const materializedEvidenceBundles: HostEvidenceBundle[] = [];
    const bundleDirectory = join(artifactsPath, "evidence-bundles");
    await mkdir(bundleDirectory, { recursive: true });
    const attemptPrefix = basename(transcriptPath(artifactsPath, request.attemptId), ".log");
    for (const [index, bundle] of rewrittenEvidenceBundles.entries()) {
      const id = `bundle-${String(index + 1).padStart(3, "0")}.json`;
      const sandboxPath = `${SANDBOX_EVIDENCE_BUNDLES_PATH}/${id}`;
      const materialized = { ...bundle, materializedPath: sandboxPath };
      const hostPath = join(bundleDirectory, `${attemptPrefix}-${id}`);
      await writeFile(hostPath, `${JSON.stringify(materialized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await redactTranscript(hostPath, this.#config);
      mounts.push({ hostPath, sandboxPath, readonly: true });
      materializedEvidenceBundles.push(JSON.parse(await readFile(hostPath, "utf8")) as HostEvidenceBundle);
    }


    const path = transcriptPath(artifactsPath, request.attemptId);
    await mkdir(join(artifactsPath, "transcripts"), { recursive: true });
    await createTranscript(path, request);
    const prompt = buildPrompt(request, kind, materializedEvidenceBundles);
    const scratch = await createScratch(workspacePath, artifactsPath, mounts, this.#config);
    return {
      kind,
      attemptId: request.attemptId,
      sessionId: request.sessionId,
      workspacePath,
      prompt: `${prompt}

## Temporary scratch
Writable per-operation scratch: ${SANDBOX_SCRATCH_PATH}
Use this directory for probe helpers, temporary scripts, logs, and exploratory output. It is isolated from the workspace and read-only inputs, is not publication input, and is removed after confirmed worker shutdown. Do not create workspace links to scratch or place temporary helpers under .factory or elsewhere in the repository. Put durable evidence in the completion report, not scratch paths.
Scratch permission does not widen the assigned stage's workspace write scope. Test design and correction may change only the candidate suite in the workspace; all other temporary writes belong in scratch. Never modify mounted skills, the authoritative suite, or the trusted runner.
`,
      transcriptPath: path,
      branchStrategy: { type: "head" },
      mounts,
      scratch,
      signal,
    };
  }
}

async function createTranscript(path: string, request: AgentAttemptRequest): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile([
      "--- Orchestrator attempt created ---",
      `run: ${request.runId}`,
      `attempt: ${request.attemptId}`,
      `session: ${request.sessionId}`,
      `deadline: ${new Date(request.deadline).toISOString()}`,
      "lifecycle: transcript-ready",
      "",
    ].join("\n"), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseRunnerOutcome(
  request: AgentAttemptRequest,
  kind: RunnerInvocation["kind"],
  report: unknown,
  evidence: readonly string[],
): AgentAttemptOutcome {
  if (kind === "stage") {
    const stageRequest = request as AttemptRequest;
    const parsedReport = stageReportSchema.safeParse(report);
    if (!parsedReport.success) {
      return executionFailure(
        request,
        `Attempt ${request.attemptId} produced an invalid stage report: ${parsedReport.error.issues
          .map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
          .join("; ")}`,
        evidence,
      );
    }
    if (parsedReport.data.stage !== stageRequest.stage) {
      return executionFailure(
        stageRequest,
        `Attempt ${request.attemptId} reported stage ${parsedReport.data.stage}, expected ${stageRequest.stage}.`,
        evidence,
      );
    }
    return completedStageOutcome(stageRequest, parsedReport.data, evidence);
  }

  const parsedReport = pullRequestReportSchema.safeParse(report);
  if (!parsedReport.success) {
    return executionFailure(
      request,
      `Attempt ${request.attemptId} produced an invalid pull-request report: ${parsedReport.error.issues
        .map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
        .join("; ")}`,
      evidence,
    );
  }
  return completedPullRequestOutcome(
    request as PullRequestAttemptRequest,
    parsedReport.data,
    evidence,
  );
}

async function emitRunnerFinished(
  emit: AttemptEventObserver,
  attemptId: string,
  status: "completed" | AttemptFailureStatus,
  runtimeSessionPresent: boolean,
): Promise<void> {
  await emit({
    type: "attempt-runner-finished",
    eventClass: "transition",
    operationId: attemptId,
    details: { status, runtimeSessionPresent },
  });
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, milliseconds);
  timer.unref();
  return promise;
}

export function createExecutionBackend(config: ExecutionBackendConfig): ExecutionBackendPort {
  return new ExecutionBackend(config);
}

function validateConfig(config: ExecutionBackendConfig): ExecutionBackendConfig {
  for (const [name, value] of [
    ["imageName", config.imageName],
    ["authFile", config.authFile],
    ["modelId", config.modelId],
    ["artifactsPath", config.artifactsPath],
  ] as const) {
    if (value.trim().length === 0) {
      throw new Error(`Execution backend ${name} must not be empty.`);
    }
  }

  if (!isAbsolute(config.authFile)) {
    throw new Error("Execution backend authFile must be absolute.");
  }
  if (!isAbsolute(config.artifactsPath)) {
    throw new Error("Execution backend artifactsPath must be absolute.");
  }
  if (config.idleTimeoutSeconds !== undefined && config.idleTimeoutSeconds <= 0) {
    throw new Error("Execution backend idleTimeoutSeconds must be positive when provided.");
  }
  for (const [name, value] of [
    ["attemptShutdownGraceMs", config.attemptShutdownGraceMs],
    ["statusIntervalMs", config.statusIntervalMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`Execution backend ${name} must be a positive safe integer when provided.`);
    }
  }
  if (config.network !== undefined && config.network.trim().length === 0) {
    throw new Error("Execution backend network must not be empty when provided.");
  }
  for (const [name, value] of [
    ["containerUid", config.containerUid],
    ["containerGid", config.containerGid],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Execution backend ${name} must be a non-negative integer when provided.`);
    }
  }

  return Object.freeze({ ...config });
}

function validateRequest(request: AgentAttemptRequest, kind: RunnerInvocation["kind"]): void {
  if (!Number.isFinite(request.deadline)) {
    throw new Error(`Attempt ${request.attemptId} has a non-finite deadline.`);
  }
  if (kind === "stage") {
    const stageRequest = request as AttemptRequest;
    if (stageRequest.context.stage !== stageRequest.stage
      || stageRequest.context.attempt !== stageRequest.attempt) {
      throw new Error(`Attempt ${request.attemptId} context identity does not match its request.`);
    }
  }
}

async function ensureDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return realpath(path);
}

async function createScratch(
  workspacePath: string,
  artifactsPath: string,
  mounts: readonly ReadonlyMount[],
  config: ExecutionBackendConfig,
): Promise<ScratchMount> {
  const temporaryPath = await realpath(tmpdir());
  const protectedPaths = [workspacePath, artifactsPath, ...mounts.map(({ hostPath }) => hostPath)];
  if (protectedPaths.some((path) => containsPath(path, temporaryPath))) {
    throw new Error("Scratch must be disjoint from the workspace, artifacts, and protected inputs.");
  }
  const root = await mkdtemp(join(temporaryPath, "factory-scratch-"));
  try {
    for (const protectedPath of protectedPaths) {
      if (containsPath(protectedPath, root) || containsPath(root, protectedPath)) {
        throw new Error("Scratch must be disjoint from the workspace, artifacts, and protected inputs.");
      }
    }
    const hostPath = join(root, "work");
    await mkdir(hostPath, { mode: 0o700 });
    const uid = config.containerUid ?? process.getuid?.() ?? 1000;
    const gid = config.containerGid ?? process.getgid?.() ?? 1000;
    if (uid !== process.getuid?.() || gid !== process.getgid?.()) {
      // Match Docker's effective identity without exposing scratch to other host users.
      await chown(hostPath, uid, gid);
    }
    return { hostPath, sandboxPath: SANDBOX_SCRATCH_PATH, readonly: false };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === ""
    || (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

function assertOutsideWorkspace(workspacePath: string, candidatePath: string, label: string): void {
  if (containsPath(workspacePath, candidatePath)) {
    throw new Error(`${label} must be outside the agent-writable workspace.`);
  }
}

function transcriptPath(artifactsPath: string, attemptId: string): string {
  const prefix = attemptId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "attempt";
  const digest = createHash("sha256").update(attemptId).digest("hex").slice(0, 12);
  return join(artifactsPath, "transcripts", `${prefix}-${digest}.log`);
}

function buildPrompt(
  request: AgentAttemptRequest,
  kind: RunnerInvocation["kind"],
  evidenceBundles: readonly HostEvidenceBundle[],
): string {
  const standards = request.context.standards.map((path) =>
    `${OPENCODE_SKILLS_PATH}/${basename(path)}/SKILL.md`
  );
  if (kind === "pull-request") {
    const pullRequest = request as PullRequestAttemptRequest;
    return buildPullRequestPrompt({
      ...pullRequest,
      workspacePath: "/home/agent/workspace",
      context: { ...pullRequest.context, standards, evidenceBundles },
    });
  }

  const stageRequest = request as AttemptRequest;
  const acceptanceSuite = stageRequest.context.acceptanceSuite;
  return buildStagePrompt({
    ...stageRequest,
    workspacePath: "/home/agent/workspace",
    context: {
      ...stageRequest.context,
      standards,
      evidenceBundles,
      ...(acceptanceSuite === undefined
        ? {}
        : { acceptanceSuite: { ...acceptanceSuite, path: `${SANDBOX_INPUTS_PATH}/acceptance` } }),
    },
  });
}

function evidenceArtifacts(
  bundles: readonly HostEvidenceBundle[],
): EvidenceArtifactReference[] {
  const artifacts: EvidenceArtifactReference[] = [];
  for (const bundle of bundles) {
    if (bundle.changePackage !== undefined) artifacts.push(bundle.changePackage);
    for (const check of bundle.checks) {
      if (check.outputArtifact !== undefined) artifacts.push(check.outputArtifact);
    }
    for (const report of bundle.reportReferences) artifacts.push(report.artifact);
  }
  return artifacts;
}

function rewriteEvidenceBundles(
  bundles: readonly HostEvidenceBundle[],
  paths: ReadonlyMap<string, string>,
): HostEvidenceBundle[] {
  return bundles.map((bundle) => ({
    ...bundle,
    ...(bundle.changePackage === undefined
      ? {}
      : { changePackage: { ...bundle.changePackage, path: paths.get(bundle.changePackage.path)! } }),
    checks: bundle.checks.map((check) => ({
      ...check,
      ...(check.outputArtifact === undefined
        ? {}
        : { outputArtifact: { ...check.outputArtifact, path: paths.get(check.outputArtifact.path)! } }),
    })),
    reportReferences: bundle.reportReferences.map((report) => ({
      ...report,
      artifact: { ...report.artifact, path: paths.get(report.artifact.path)! },
    })),
  }));
}

function completedStageOutcome(
  request: AttemptRequest,
  report: StageReport,
  evidence: readonly string[],
): AttemptOutcome {
  return {
    status: "completed",
    attemptId: request.attemptId,
    sessionId: request.sessionId,
    report,
    evidence,
  };
}

function completedPullRequestOutcome(
  request: PullRequestAttemptRequest,
  report: PullRequestReport,
  evidence: readonly string[],
): PullRequestAttemptOutcome {
  return {
    status: "completed",
    attemptId: request.attemptId,
    sessionId: request.sessionId,
    report,
    evidence,
  };
}

function executionFailure(
  request: AgentAttemptRequest,
  error: string,
  evidence: readonly string[],
): AgentAttemptOutcome {
  return {
    status: "execution-failure",
    attemptId: request.attemptId,
    sessionId: request.sessionId,
    error,
    evidence,
  };
}

function abortedOutcome(
  request: AgentAttemptRequest,
  cause: Exclude<AbortCause, undefined>,
  evidencePath: string,
): AgentAttemptOutcome {
  return {
    status: cause,
    attemptId: request.attemptId,
    sessionId: request.sessionId,
    error:
      cause === "timeout"
        ? `Attempt ${request.attemptId} reached deadline ${request.deadline}.`
        : `Attempt ${request.attemptId} was cancelled and stopped.`,
    evidence: [evidencePath],
  };
}

function shutdownStalledOutcome(
  request: AgentAttemptRequest,
  evidencePath: string,
): AgentAttemptOutcome {
  return {
    status: "shutdown-stalled",
    attemptId: request.attemptId,
    sessionId: request.sessionId,
    error: `Attempt ${request.attemptId} did not stop within the configured shutdown grace.`,
    evidence: [evidencePath],
  };
}

function formatExecutionError(attemptId: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Attempt ${attemptId} execution failed: ${detail}`;
}

async function redactTranscript(
  path: string,
  config: ExecutionBackendConfig,
  additionalSecrets: readonly string[] = [],
): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const auth: unknown = JSON.parse(await readFile(config.authFile, "utf8"));
  const secrets = [...additionalSecrets, ...collectSecretStrings(auth)]
    .filter((secret, index, values) => values.indexOf(secret) === index)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) content = content.replaceAll(secret, "[REDACTED]");
  const temporaryPath = `${path}.redacted-${process.pid}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

function collectSecretStrings(value: unknown): string[] {
  if (typeof value === "string") return value.length === 0 ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(collectSecretStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectSecretStrings);
  }
  return [];
}
