import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  buildStagePrompt,
  stageReportSchema,
  type AttemptOutcome,
  type AttemptRequest,
  type ExecutionBackendPort,
  type StageReport,
} from "@factory/core";
import { SandcastleRunner } from "./sandcastle-runner.js";

const SANDBOX_INPUTS_PATH = "/home/agent/factory-inputs";

export interface ExecutionBackendConfig {
  readonly imageName: string;
  readonly endpoint: string;
  readonly modelId: string;
  readonly artifactsPath: string;
  readonly network?: string;
  readonly containerUid?: number;
  readonly containerGid?: number;
  readonly idleTimeoutSeconds?: number;
}

export interface ReadonlyMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly: true;
}

export interface RunnerInvocation {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly prompt: string;
  readonly transcriptPath: string;
  readonly branchStrategy: {
    readonly type: "head";
  };
  readonly mounts: readonly ReadonlyMount[];
  readonly signal: AbortSignal;
}

export interface RunnerResult {
  readonly report: unknown;
  readonly runtimeSessionId?: string;
  readonly evidence: readonly string[];
}

export interface SandcastleAttemptRunner {
  run(invocation: RunnerInvocation): Promise<RunnerResult>;
}

interface ActiveAttempt {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
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

  async runAttempt(request: AttemptRequest, signal: AbortSignal): Promise<AttemptOutcome> {
    const identityError = this.#claimIdentity(request);
    if (identityError !== undefined) {
      return executionFailure(request, identityError, []);
    }

    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    const activeAttempt: ActiveAttempt = {
      controller,
      completion: completion.promise,
      resolveCompletion: completion.resolve,
    };
    this.#activeAttempts.set(request.attemptId, activeAttempt);

    let abortCause: AbortCause;
    const cancelFromCaller = () => {
      abortCause ??= "cancelled";
      controller.abort(signal.reason ?? new AttemptStoppedError(request.attemptId));
    };
    signal.addEventListener("abort", cancelFromCaller, { once: true });
    if (signal.aborted) {
      cancelFromCaller();
    }

    let deadlineTimer: NodeJS.Timeout | undefined;
    const cancelAtDeadline = () => {
      const remainingMs = request.deadline - Date.now();
      if (remainingMs <= 0) {
        abortCause ??= "timeout";
        controller.abort(new AttemptTimeoutError(request.attemptId));
        return;
      }

      deadlineTimer = setTimeout(cancelAtDeadline, Math.min(remainingMs, 2_147_483_647));
      deadlineTimer.unref();
    };

    try {
      validateRequest(request);
      cancelAtDeadline();
      const invocation = await this.#createInvocation(request, controller.signal);
      const result = await this.#runner.run(invocation);

      if (abortCause !== undefined || controller.signal.aborted) {
        return abortedOutcome(request, abortCause ?? "cancelled", invocation.transcriptPath);
      }

      if (result.runtimeSessionId === undefined || result.runtimeSessionId.length === 0) {
        return executionFailure(
          request,
          `Attempt ${request.attemptId} did not expose a new OpenCode runtime session identity.`,
          result.evidence,
        );
      }
      if (this.#seenRuntimeSessionIds.has(result.runtimeSessionId)) {
        return executionFailure(
          request,
          `Attempt ${request.attemptId} reused OpenCode runtime session ${result.runtimeSessionId}.`,
          result.evidence,
        );
      }
      this.#seenRuntimeSessionIds.add(result.runtimeSessionId);

      const parsedReport = stageReportSchema.safeParse(result.report);
      if (!parsedReport.success) {
        return executionFailure(
          request,
          `Attempt ${request.attemptId} produced an invalid stage report: ${parsedReport.error.issues
            .map((issue) => `${issue.path.join(".") || "report"}: ${issue.message}`)
            .join("; ")}`,
          result.evidence,
        );
      }
      if (parsedReport.data.stage !== request.stage) {
        return executionFailure(
          request,
          `Attempt ${request.attemptId} reported stage ${parsedReport.data.stage}, expected ${request.stage}.`,
          result.evidence,
        );
      }

      return completedOutcome(request, parsedReport.data, result.evidence);
    } catch (error) {
      if (abortCause !== undefined || controller.signal.aborted) {
        const cause = abortCause ?? "cancelled";
        return abortedOutcome(request, cause, transcriptPath(this.#config.artifactsPath, request.attemptId));
      }
      return executionFailure(request, formatExecutionError(request.attemptId, error), [
        transcriptPath(this.#config.artifactsPath, request.attemptId),
      ]);
    } finally {
      await redactTranscript(
        transcriptPath(this.#config.artifactsPath, request.attemptId),
        this.#config,
      ).catch(async () => {
        await rm(transcriptPath(this.#config.artifactsPath, request.attemptId), { force: true });
      });
      clearTimeout(deadlineTimer);
      signal.removeEventListener("abort", cancelFromCaller);
      if (this.#activeAttempts.get(request.attemptId) === activeAttempt) {
        this.#activeAttempts.delete(request.attemptId);
      }
      activeAttempt.resolveCompletion();
    }
  }

  async stopAttempt(attemptId: string): Promise<void> {
    const activeAttempt = this.#activeAttempts.get(attemptId);
    if (activeAttempt === undefined) {
      return;
    }

    activeAttempt.controller.abort(new AttemptStoppedError(attemptId));
    await activeAttempt.completion;
  }

  #claimIdentity(request: AttemptRequest): string | undefined {
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

  async #createInvocation(request: AttemptRequest, signal: AbortSignal): Promise<RunnerInvocation> {
    const workspacePath = await realpath(request.workspacePath);
    const artifactsPath = await ensureDirectory(this.#config.artifactsPath);
    assertOutsideWorkspace(workspacePath, artifactsPath, "Artifact directory");

    const mounts: ReadonlyMount[] = [];
    for (const [index, standardsPath] of request.context.standards.entries()) {
      const hostPath = await realpath(standardsPath);
      assertOutsideWorkspace(workspacePath, hostPath, `Standards input ${index + 1}`);
      mounts.push({
        hostPath,
        sandboxPath: `${SANDBOX_INPUTS_PATH}/standards/${index + 1}`,
        readonly: true,
      });
    }

    let acceptanceSuitePath: string | undefined;
    if (request.context.acceptanceSuite !== undefined) {
      acceptanceSuitePath = await realpath(request.context.acceptanceSuite.path);
      assertOutsideWorkspace(workspacePath, acceptanceSuitePath, "Authoritative acceptance suite");
      mounts.push({
        hostPath: acceptanceSuitePath,
        sandboxPath: `${SANDBOX_INPUTS_PATH}/acceptance`,
        readonly: true,
      });
    }

    const path = transcriptPath(artifactsPath, request.attemptId);
    await mkdir(join(artifactsPath, "transcripts"), { recursive: true });

    return {
      attemptId: request.attemptId,
      sessionId: request.sessionId,
      workspacePath,
      prompt: buildPrompt(request),
      transcriptPath: path,
      branchStrategy: { type: "head" },
      mounts,
      signal,
    };
  }
}

export function createExecutionBackend(config: ExecutionBackendConfig): ExecutionBackendPort {
  return new ExecutionBackend(config);
}

function validateConfig(config: ExecutionBackendConfig): ExecutionBackendConfig {
  for (const [name, value] of [
    ["imageName", config.imageName],
    ["modelId", config.modelId],
    ["artifactsPath", config.artifactsPath],
  ] as const) {
    if (value.trim().length === 0) {
      throw new Error(`Execution backend ${name} must not be empty.`);
    }
  }

  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new Error("Execution backend endpoint must be a valid HTTP(S) URL.");
  }
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username || endpoint.password) {
    throw new Error("Execution backend endpoint must be an HTTP(S) URL without embedded credentials.");
  }
  if (endpoint.search.length > 0 || endpoint.hash.length > 0) {
    throw new Error("Execution backend endpoint must not contain a query string or fragment.");
  }
  if (!isAbsolute(config.artifactsPath)) {
    throw new Error("Execution backend artifactsPath must be absolute.");
  }
  if (config.idleTimeoutSeconds !== undefined && config.idleTimeoutSeconds <= 0) {
    throw new Error("Execution backend idleTimeoutSeconds must be positive when provided.");
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

  return Object.freeze({ ...config, endpoint: endpoint.toString().replace(/\/$/, "") });
}

function validateRequest(request: AttemptRequest): void {
  if (!Number.isFinite(request.deadline)) {
    throw new Error(`Attempt ${request.attemptId} has a non-finite deadline.`);
  }
  if (request.context.stage !== request.stage || request.context.attempt !== request.attempt) {
    throw new Error(`Attempt ${request.attemptId} context identity does not match its request.`);
  }
}

async function ensureDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return realpath(path);
}

function assertOutsideWorkspace(workspacePath: string, candidatePath: string, label: string): void {
  const pathFromWorkspace = relative(workspacePath, candidatePath);
  if (pathFromWorkspace === "" || (!pathFromWorkspace.startsWith("..") && !isAbsolute(pathFromWorkspace))) {
    throw new Error(`${label} must be outside the agent-writable workspace.`);
  }
}

function transcriptPath(artifactsPath: string, attemptId: string): string {
  const prefix = attemptId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "attempt";
  const digest = createHash("sha256").update(attemptId).digest("hex").slice(0, 12);
  return join(artifactsPath, "transcripts", `${prefix}-${digest}.log`);
}

function buildPrompt(request: AttemptRequest): string {
  const acceptanceSuite = request.context.acceptanceSuite;
  const sandboxRequest: AttemptRequest = {
    ...request,
    workspacePath: "/home/agent/workspace",
    context: {
      ...request.context,
      standards: request.context.standards.map((_, index) => `${SANDBOX_INPUTS_PATH}/standards/${index + 1}`),
      ...(acceptanceSuite === undefined
        ? {}
        : { acceptanceSuite: { ...acceptanceSuite, path: `${SANDBOX_INPUTS_PATH}/acceptance` } }),
    },
  };
  return buildStagePrompt(sandboxRequest);
}

function completedOutcome(
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

function executionFailure(
  request: AttemptRequest,
  error: string,
  evidence: readonly string[],
): AttemptOutcome {
  return {
    status: "execution-failure",
    attemptId: request.attemptId,
    sessionId: request.sessionId,
    error,
    evidence,
  };
}

function abortedOutcome(
  request: AttemptRequest,
  cause: Exclude<AbortCause, undefined>,
  evidencePath: string,
): AttemptOutcome {
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

function formatExecutionError(attemptId: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Attempt ${attemptId} execution failed: ${detail}`;
}

async function redactTranscript(path: string, config: ExecutionBackendConfig): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const endpoint = new URL(config.endpoint);
  const secrets = [endpoint.username, endpoint.password, endpoint.search]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) content = content.replaceAll(secret, "[REDACTED]");
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  content = content.replaceAll(config.endpoint, endpoint.toString());
  const temporaryPath = `${path}.redacted-${process.pid}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}
