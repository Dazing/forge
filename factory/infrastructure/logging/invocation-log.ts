import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { redactSecrets } from "../../shared/redact-secret.js";

/** One allocated agent transcript: the absolute path to write and the invocation-relative reference recorded in checkpoint commits, ticket annotations, and main.log. */
export type AllocatedTranscript = Readonly<{ path: string; reference: string }>;

/** Generic log targets: `sequence` places zero-padded numbered files in a fixed directory (planner cycles); `attempt` places stage-numbered files in the one directory bound to an attempt ID. */
export type LogTarget =
  | Readonly<{ scope: "sequence"; directory: string; cycle: number }>
  | Readonly<{ scope: "attempt"; attemptId: string; stage: string }>;

/** Path segments accepted for log directories, attempt IDs, and stage names: no separators, traversal, whitespace, control characters, leading dot, or empty value. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireSegment(value: string, label: string): string {
  if (value.length === 0) throw new Error(`log ${label} is empty.`);
  if (!SAFE_SEGMENT.test(value)) throw new Error(`log ${label} ${JSON.stringify(value)} is not a safe path segment.`);
  return value;
}

function requireCycle(cycle: number): number {
  if (!Number.isInteger(cycle) || cycle <= 0) throw new Error(`log cycle ${cycle} is not a positive integer.`);
  return cycle;
}

/** Second-resolution UTC stamp, sortable by name: `2026-10-12_09-30-15`. */
function utcStamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", "_").replaceAll(":", "-");
}

interface MainLogRecord {
  timestamp: string;
  ticketId?: string;
  attemptId?: string;
  stage: string;
  operation: string;
  status: "completed" | "failed" | "success" | "blocked";
  stdout?: string;
  stderr?: string;
  parentSha?: string;
  checkpointSha?: string;
  changes?: string;
  agentLogReference?: string;
}

class InvocationLogger {
  private readonly allocations = new Map<string, number>();
  private readonly attemptDirs = new Map<string, string>();

  private constructor(
    readonly runDir: string,
    readonly mainLogPath: string,
    private readonly secrets: readonly string[],
  ) {}

  /** Create one fresh instance directory `.logs/<utc-stamp>-<6-hex>/` with `main.log` at its root; collisions regenerate the random suffix. Every recorded stdout/stderr is redacted with the aggregate credential set. */
  static async create(factoryRoot: string, secrets: readonly string[]): Promise<InvocationLogger> {
    const logsRoot = resolve(factoryRoot, ".logs");
    await mkdir(logsRoot, { recursive: true });
    const stamp = utcStamp();
    for (let generation = 0; generation < 16; generation++) {
      const runDir = resolve(logsRoot, `${stamp}-${randomBytes(3).toString("hex")}`);
      try {
        await mkdir(runDir);
        return new InvocationLogger(runDir, resolve(runDir, "main.log"), secrets);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
        throw error;
      }
    }
    throw new Error(`Could not reserve a fresh invocation log directory under ${logsRoot}.`);
  }

  /** Allocate the next transcript for a validated target; every allocation consumes a new number, so a run that fails still keeps its transcript. */
  async allocate(target: LogTarget): Promise<AllocatedTranscript> {
    const segment = target.scope === "sequence"
      ? requireSegment(target.directory, "directory")
      : requireSegment(target.attemptId, "attempt ID");
    const label = target.scope === "sequence" ? String(requireCycle(target.cycle)) : requireSegment(target.stage, "stage");
    const key = `${target.scope}\n${segment}\n${label}`;
    const number = (this.allocations.get(key) ?? 0) + 1;
    this.allocations.set(key, number);
    const directory = target.scope === "sequence" ? segment : this.bindAttemptDirectory(target.attemptId);
    const filename = target.scope === "sequence"
      ? `${label.padStart(3, "0")}${number === 1 ? "" : `-${number}`}.log`
      : `${label}-${number}.log`;
    return this.createTranscript(directory, filename);
  }

  /** Bind an attempt ID to its timestamped directory once; the binding is immutable for the invocation, so concurrent first allocations converge on one directory. */
  private bindAttemptDirectory(attemptId: string): string {
    const bound = this.attemptDirs.get(attemptId);
    if (bound !== undefined) return bound;
    const directory = `${utcStamp()}-${attemptId}`;
    this.attemptDirs.set(attemptId, directory);
    return directory;
  }

  private async createTranscript(directory: string, filename: string): Promise<AllocatedTranscript> {
    await mkdir(resolve(this.runDir, directory), { recursive: true });
    return { path: resolve(this.runDir, directory, filename), reference: posix.join(directory, filename) };
  }

  async record(record: MainLogRecord): Promise<void> {
    const fields = [record.timestamp];
    if (record.ticketId !== undefined) fields.push(`ticket=${record.ticketId}`);
    if (record.attemptId !== undefined) fields.push(`attempt=${record.attemptId}`);
    fields.push(`stage=${record.stage}`, `operation=${record.operation}`, `status=${record.status}`);
    if (record.parentSha !== undefined) fields.push(`parent=${record.parentSha}`);
    if (record.checkpointSha !== undefined) fields.push(`checkpoint=${record.checkpointSha}`);
    if (record.changes !== undefined) fields.push(`changes=${record.changes}`);
    if (record.agentLogReference !== undefined) fields.push(`agent-log=${record.agentLogReference}`);
    const line = `${fields.join(" ")}\n`;
    const output: string[] = [];
    if (record.stdout !== undefined) output.push(`stdout:\n${redactSecrets(this.secrets, record.stdout)}`);
    if (record.stderr !== undefined) output.push(`stderr:\n${redactSecrets(this.secrets, record.stderr)}`);
    await appendFile(this.mainLogPath, `${line}${output.length === 0 ? "" : `${output.join("\n")}\n`}`);
  }
}

export { InvocationLogger };
export type { MainLogRecord };
