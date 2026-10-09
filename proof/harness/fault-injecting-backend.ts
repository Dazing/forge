import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  AttemptOutcome,
  AttemptRequest,
  ExecutionBackendPort,
  Stage,
} from "@factory/core";

export interface AttemptFault {
  readonly stage: Stage;
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
      .map((fault) => `${fault.stage}:${fault.attempt}`)
      .filter((identity) => !this.#realizedFaults.has(identity));
    if (missing.length > 0) {
      throw new Error(`Proof did not realize configured faults: ${missing.join(", ")}`);
    }
  }


  async runAttempt(request: AttemptRequest, signal: AbortSignal): Promise<AttemptOutcome> {
    const before = await digestWorkspace(request.workspacePath);
    const outcome = await this.#backend.runAttempt(request, signal);
    const fault = this.#faults.find((candidate) =>
      candidate.stage === request.stage && candidate.attempt === request.attempt);
    if (!fault || outcome.status !== "completed") return outcome;
    const after = await digestWorkspace(request.workspacePath);
    if (after === before) {
      throw new Error(`Proof fault ${fault.point} required a changed workspace, but no change was observed`);
    }
    this.#realizedFaults.add(`${fault.stage}:${fault.attempt}`);
    return {
      status: "execution-failure",
      attemptId: outcome.attemptId,
      sessionId: outcome.sessionId,
      error: `Injected proof fault at ${fault.point}`,
      evidence: [...outcome.evidence, `fault:${request.stage}:${request.attempt}:${fault.point}`],
    };
  }

  stopAttempt(attemptId: string): Promise<void> {
    return this.#backend.stopAttempt(attemptId);
  }
}

async function digestWorkspace(root: string): Promise<string> {
  const files: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && (entry.name === ".git" || entry.name === ".sandcastle")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else files.push(path);
    }
  }
  await collect(root);
  files.sort();
  const digest = createHash("sha256");
  for (const path of files) {
    digest.update(relative(root, path).split(sep).join("/"));
    digest.update("\0");
    const metadata = await lstat(path);
    digest.update(metadata.isSymbolicLink() ? `link:${await readlink(path)}` : await readFile(path));
    digest.update("\n");
  }
  return digest.digest("hex");
}
