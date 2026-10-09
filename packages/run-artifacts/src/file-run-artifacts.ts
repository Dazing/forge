import {
  appendFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ArtifactEvent,
  RunArtifactsPort,
  RunOutcome,
} from "@factory/core";

const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const REDACTION = "[REDACTED]";
const URL_PATTERN = /https?:\/\/[^\s"'<>\])}]+/giu;

export interface FileRunArtifactsOptions {
  readonly rootDirectory: string;
  readonly agentWorkspacePath: string;
  readonly runId: string;
  readonly secretValues?: readonly string[];
  readonly maxArtifactBytes?: number;
  readonly now?: () => Date;
}

interface FinalReport {
  readonly reportVersion: 1;
  readonly generatedAt: string;
  readonly outcome: Omit<RunOutcome, "reportPath">;
  readonly events: readonly ArtifactEvent[];
}

/** Filesystem-backed, host-owned evidence for exactly one factory run. */
export class FileRunArtifacts implements RunArtifactsPort {
  readonly runDirectory: string;

  readonly #agentWorkspacePath: string;
  readonly #artifactDirectory: string;
  readonly #eventPath: string;
  readonly #initialization: Promise<void>;
  readonly #maxArtifactBytes: number;
  readonly #now: () => Date;
  readonly #runId: string;
  readonly #secretValues: readonly string[];
  #finalized = false;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: FileRunArtifactsOptions) {
    validateRunId(options.runId);
    if (!Number.isSafeInteger(options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES)
      || (options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES) < 1) {
      throw new Error("maxArtifactBytes must be a positive safe integer");
    }

    this.#runId = options.runId;
    this.#agentWorkspacePath = resolve(options.agentWorkspacePath);
    this.runDirectory = resolve(options.rootDirectory, options.runId);
    if (isPathWithin(this.runDirectory, this.#agentWorkspacePath)) {
      throw new Error(`Run evidence directory must be outside the agent workspace: ${this.runDirectory}`);
    }

    this.#artifactDirectory = resolve(this.runDirectory, "artifacts");
    this.#eventPath = resolve(this.runDirectory, "events.jsonl");
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.#now = options.now ?? (() => new Date());
    this.#secretValues = [...new Set(options.secretValues?.filter((value) => value.length > 0) ?? [])]
      .sort((left, right) => right.length - left.length);
    this.#initialization = this.#initialize(resolve(options.rootDirectory));
  }

  record(event: ArtifactEvent): Promise<void> {
    return this.#enqueue(async () => {
      await this.#readyForWrite("record event");
      if (event.runId !== this.#runId) {
        throw new Error(`Cannot record event for run ${event.runId} in evidence for run ${this.#runId}`);
      }

      const line = `${this.#serialize(event, "event")}\n`;
      await appendFile(this.#eventPath, line, { encoding: "utf8", flag: "a", mode: 0o600 });
    });
  }

  attach(name: string, content: string | Uint8Array): Promise<string> {
    return this.#enqueue(async () => {
      await this.#readyForWrite(`attach ${name}`);
      const safeName = validateArtifactName(name);
      const artifactPath = resolve(this.#artifactDirectory, ...safeName.split("/"));
      if (!isPathWithin(artifactPath, this.#artifactDirectory)) {
        throw new Error(`Artifact name must be a safe relative path: ${name}`);
      }

      const serialized = typeof content === "string" ? this.#redactText(content) : content;
      const byteLength = typeof serialized === "string"
        ? Buffer.byteLength(serialized, "utf8")
        : serialized.byteLength;
      if (byteLength > this.#maxArtifactBytes) {
        throw new Error(`Artifact ${name} exceeds the ${this.#maxArtifactBytes} bytes limit`);
      }

      await mkdir(resolve(artifactPath, ".."), { recursive: true, mode: 0o700 });
      try {
        await this.#writeExclusive(artifactPath, serialized);
      } catch (error) {
        throw new Error(`Could not attach artifact ${name}: ${errorMessage(error)}`, { cause: error });
      }
      return artifactPath;
    });
  }

  finalize(outcome: Omit<RunOutcome, "reportPath">): Promise<string> {
    return this.#enqueue(async () => {
      await this.#readyForWrite("finalize report");
      if (outcome.runId !== this.#runId) {
        throw new Error(`Cannot finalize run ${outcome.runId} in evidence for run ${this.#runId}`);
      }

      const events = await this.#readEvents();
      const report: FinalReport = {
        reportVersion: 1,
        generatedAt: this.#now().toISOString(),
        outcome,
        events,
      };
      const reportJson = `${this.#serialize(report, "final report")}\n`;
      const reportMarkdown = this.#redactText(renderMarkdown(report));
      const jsonPath = resolve(this.runDirectory, "report.json");
      const markdownPath = resolve(this.runDirectory, "report.md");
      const nonce = `${process.pid}-${crypto.randomUUID()}`;
      const temporaryJsonPath = resolve(this.runDirectory, `.report.json.tmp-${nonce}`);
      const temporaryMarkdownPath = resolve(this.runDirectory, `.report.md.tmp-${nonce}`);
      let markdownPublished = false;

      try {
        await Promise.all([
          this.#writeExclusive(temporaryJsonPath, reportJson),
          this.#writeExclusive(temporaryMarkdownPath, reportMarkdown),
        ]);
        await rename(temporaryMarkdownPath, markdownPath);
        markdownPublished = true;
        // report.json is the publication marker: whenever it is visible, report.md is complete too.
        await rename(temporaryJsonPath, jsonPath);
        this.#finalized = true;
        return jsonPath;
      } catch (error) {
        await Promise.all([
          rm(temporaryJsonPath, { force: true }),
          rm(temporaryMarkdownPath, { force: true }),
          ...(markdownPublished ? [rm(markdownPath, { force: true })] : []),
        ]);
        throw new Error(`Could not atomically finalize run report: ${errorMessage(error)}`, { cause: error });
      }
    });
  }

  async #initialize(rootDirectory: string): Promise<void> {
    await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    const [canonicalRoot, canonicalWorkspace] = await Promise.all([
      realpath(rootDirectory),
      canonicalizeProspectivePath(this.#agentWorkspacePath),
    ]);
    const canonicalRunDirectory = resolve(canonicalRoot, this.#runId);
    if (isPathWithin(canonicalRunDirectory, canonicalWorkspace)) {
      throw new Error(`Run evidence directory must be outside the agent workspace: ${canonicalRunDirectory}`);
    }

    try {
      await mkdir(canonicalRunDirectory, { mode: 0o700 });
      await mkdir(resolve(canonicalRunDirectory, "artifacts"), { mode: 0o700 });
      await this.#writeExclusive(resolve(canonicalRunDirectory, "events.jsonl"), "");
    } catch (error) {
      throw new Error(`Could not create new evidence directory for run ${this.#runId}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async #readyForWrite(operation: string): Promise<void> {
    await this.#initialization;
    if (this.#finalized) {
      throw new Error(`Cannot ${operation}: run ${this.#runId} is already finalized`);
    }
  }

  async #readEvents(): Promise<ArtifactEvent[]> {
    const text = await readFile(this.#eventPath, "utf8");
    if (text.length === 0) {
      return [];
    }
    return text.trimEnd().split("\n").map((line, index) => {
      try {
        return JSON.parse(line) as ArtifactEvent;
      } catch (error) {
        throw new Error(`Could not parse evidence event at line ${index + 1}: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(() => undefined, () => undefined);
    return result;
  }

  #serialize(value: unknown, description: string): string {
    try {
      const serialized = JSON.stringify(redactValue(value, (text) => this.#redactText(text)));
      if (serialized === undefined) {
        throw new Error("value is not JSON serializable");
      }
      return serialized;
    } catch (error) {
      throw new Error(`Could not serialize ${description}: ${errorMessage(error)}`, { cause: error });
    }
  }

  #redactText(text: string): string {
    let redacted = redactUrls(text);
    for (const secret of this.#secretValues) {
      redacted = redacted.split(secret).join(REDACTION);
    }
    return redacted;
  }

  async #writeExclusive(path: string, content: string | Uint8Array): Promise<void> {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) || runId === "." || runId === "..") {
    throw new Error(`Run ID must be a safe path component: ${runId}`);
  }
}

function validateArtifactName(name: string): string {
  const portableName = name.replaceAll("\\", "/");
  const segments = portableName.split("/");
  if (name.length === 0
    || isAbsolute(name)
    || /^[A-Za-z]:[\\/]/u.test(name)
    || portableName.startsWith("/")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error(`Artifact name must be a safe relative path: ${name}`);
  }
  return portableName;
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const parent = dirname(path);
    if (parent === path) {
      return path;
    }
    return resolve(await canonicalizeProspectivePath(parent), basename(path));
  }
}

function isPathWithin(candidate: string, parent: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent));
}

function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, (candidate) => {
    try {
      const endpoint = new URL(candidate);
      endpoint.username = "";
      endpoint.password = "";
      endpoint.search = "";
      endpoint.hash = "";
      return endpoint.toString();
    } catch {
      return candidate;
    }
  });
}

function redactValue(value: unknown, redact: (text: string) => string, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) {
    throw new Error("cyclic values are not JSON serializable");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, redact, ancestors));
    }
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[redact(key)] = redactValue(item, redact, ancestors);
    }
    return redacted;
  } finally {
    ancestors.delete(value);
  }
}

function renderMarkdown(report: FinalReport): string {
  const { outcome } = report;
  const lines = [
    "# Software Factory Run Report",
    "",
    `**Status:** ${outcome.status}`,
    `**Run:** ${singleLine(outcome.runId)}`,
    `**Output branch:** ${singleLine(outcome.outputBranch)}`,
    `**Base commit:** ${singleLine(outcome.baseCommit ?? "not recorded")}`,
    `**Final commit:** ${singleLine(outcome.finalCommit ?? "not produced")}`,
    `**Terminal reason:** ${singleLine(outcome.terminalReason)}`,
    "",
    "## Attempts",
    "",
    ...(outcome.attempts.length === 0
      ? ["- None"]
      : outcome.attempts.map((attempt) => `- ${attempt.stage} attempt ${attempt.attempt}: ${attempt.status} (session ${singleLine(attempt.sessionId)})`)),
    "",
    "## Acceptance criteria",
    "",
    ...(outcome.criteria.length === 0
      ? ["- None"]
      : outcome.criteria.map((criterion) => `- ${singleLine(criterion.id)}: ${criterion.verdict}`)),
    "",
    "## Recorded evidence",
    "",
    ...(report.events.length === 0
      ? ["- None"]
      : report.events.map((event) => {
        const location = [event.stage, event.attempt === undefined ? undefined : `attempt ${event.attempt}`]
          .filter((part) => part !== undefined)
          .join(", ");
        return `- ${singleLine(event.type)}${location.length > 0 ? ` (${location})` : ""}`;
      })),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
