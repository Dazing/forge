import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  AttemptEventObserver,
  AttemptOutcome,
  AttemptRequest,
  ExecutionBackendPort,
  PullRequestAttemptOutcome,
  PullRequestAttemptRequest,
  AgentOperation,
} from "@factory/core";

export interface AttemptFault {
  readonly operation: AgentOperation;
  readonly attempt: 1 | 2;
  readonly point: "after-agent-files-changed";
  readonly outcome: "execution-failure";
}

/** Proof-only deterministic attempt-boundary fault injection; production prompts remain unchanged. */
export class FaultInjectingBackend implements ExecutionBackendPort {
  readonly #backend: ExecutionBackendPort;
  readonly #faults: readonly AttemptFault[];
  readonly #realizedFaults = new Set<string>();

  constructor(backend: ExecutionBackendPort, faults: readonly AttemptFault[]) {
    this.#backend = backend;
    this.#faults = faults;
  }
  assertAllFaultsRealized(): void {
    const missing = this.#faults
      .map((fault) => `${fault.operation}:${fault.attempt}`)
      .filter((identity) => !this.#realizedFaults.has(identity));
    if (missing.length > 0) {
      throw new Error(`Proof did not realize configured faults: ${missing.join(", ")}`);
    }
  }


  async runAttempt(
    request: AttemptRequest,
    signal: AbortSignal,
    observe?: AttemptEventObserver,
  ): Promise<AttemptOutcome> {
    const fault = this.#faults.find((candidate) =>
      candidate.operation === request.operation && candidate.attempt === request.attempt);
    if (!fault) return this.#backend.runAttempt(request, signal, observe);

    let evidence: readonly string[] = [];
    try {
      const before = await digestWorkspace(request, signal);
      const outcome = await this.#backend.runAttempt(request, signal, observe);
      if (outcome.status !== "completed") return outcome;
      evidence = outcome.evidence;
      const after = await digestWorkspace(request, signal);
      if (after === before) {
        throw new Error(`Proof fault ${fault.point} required a changed workspace, but no change was observed`);
      }
      this.#realizedFaults.add(`${fault.operation}:${fault.attempt}`);
      return {
        status: "execution-failure",
        attemptId: outcome.attemptId,
        sessionId: outcome.sessionId,
        error: `Injected proof fault at ${fault.point}`,
        evidence: [...outcome.evidence, `fault:${request.operation}:${request.attempt}:${fault.point}`],
      };
    } catch (error) {
      if (!(error instanceof DigestStoppedError)) throw error;
      return {
        status: error.status,
        attemptId: request.attemptId,
        sessionId: request.sessionId,
        error: error.message,
        evidence,
      };
    }
  }

  runPullRequestAttempt(
    request: PullRequestAttemptRequest,
    signal: AbortSignal,
    observe?: AttemptEventObserver,
  ): Promise<PullRequestAttemptOutcome> {
    return this.#backend.runPullRequestAttempt(request, signal, observe);
  }

  stopAttempt(attemptId: string): Promise<void> {
    return this.#backend.stopAttempt(attemptId);
  }
}

class DigestStoppedError extends Error {
  constructor(readonly status: "cancelled" | "timeout", attemptId: string) {
    super(`Proof workspace digest for ${attemptId} ${status === "timeout" ? "reached its deadline" : "was cancelled"}.`);
  }
}

async function digestWorkspace(request: AttemptRequest, callerSignal: AbortSignal): Promise<string> {
  const root = request.workspacePath;
  const signal = AbortSignal.any([
    callerSignal,
    AbortSignal.timeout(Math.min(Math.max(0, request.deadline - Date.now()), 2_147_483_647)),
  ]);
  const checkStopped = () => {
    if (callerSignal.aborted) throw new DigestStoppedError("cancelled", request.attemptId);
    if (signal.aborted || Date.now() >= request.deadline) {
      throw new DigestStoppedError("timeout", request.attemptId);
    }
  };
  const files: string[] = [];
  async function collect(directory: string): Promise<void> {
    checkStopped();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      checkStopped();
      if (directory === root && (entry.name === ".git" || entry.name === ".sandcastle")) continue;
      const path = join(directory, entry.name);
      if (path === join(root, ".factory", "verification-runtime")) continue;
      if (entry.isDirectory()) {
        if (entry.name !== "bin" && entry.name !== "obj") await collect(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(path);
      }
    }
  }
  try {
    await collect(root);
    files.sort();
    const digest = createHash("sha256");
    for (const path of files) {
      checkStopped();
      const metadata = await lstat(path);
      let content: string | Buffer;
      if (metadata.isSymbolicLink()) {
        content = `link:${await readlink(path)}`;
      } else if (metadata.isFile()) {
        // Never block on a FIFO or follow a symlink substituted after lstat.
        const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          if (!(await handle.stat()).isFile()) continue;
          checkStopped();
          content = await handle.readFile({ signal });
        } finally {
          await handle.close();
        }
      } else {
        continue;
      }
      checkStopped();
      digest.update(relative(root, path).split(sep).join("/"));
      digest.update("\0");
      digest.update(content);
      digest.update("\n");
    }
    checkStopped();
    return digest.digest("hex");
  } catch (error) {
    checkStopped();
    throw error;
  }
}
