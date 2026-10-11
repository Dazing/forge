import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Shared invocation run directory: agent log paths and the append-only main.log, moved out of harness-agents.ts.

/** Structured record appended to the invocation main.log. */
export type MainLogRecord = Readonly<{
  timestamp: string;
  ticketId?: string;
  attemptId?: string;
  stage: string;
  operation: string;
  status: string;
  stdout?: string;
  stderr?: string;
}>;

/** Replace every literal occurrence of a secret in diagnostic text before it reaches any sink. */
export function redactSecret(secret: string, text: string): string {
  return text.replaceAll(secret, "[redacted-token]");
}

/** One invocation's `.logs/<timestamp>-<pid>/` directory: agent log file paths and structured main.log records. */
export class InvocationLogger {
  private constructor(
    readonly runDir: string,
    private readonly mainLogPath: string,
    private readonly secret: string,
  ) {}

  /** Create the run directory for this invocation under the factory root. */
  static async create(factoryRoot: string, secret: string): Promise<InvocationLogger> {
    const runDir = resolve(factoryRoot, ".logs", `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
    await mkdir(runDir, { recursive: true });
    return new InvocationLogger(runDir, resolve(runDir, "main.log"), secret);
  }

  /** Human-readable log file path for one agent stage. */
  agentLogPath(name: string): string {
    return resolve(this.runDir, `${name}.log`);
  }

  /** Append one redacted, human-readable record to main.log. */
  async record(record: MainLogRecord): Promise<void> {
    const identity = [
      ...(record.ticketId === undefined ? [] : [`ticket=${record.ticketId}`]),
      ...(record.attemptId === undefined ? [] : [`attempt=${record.attemptId}`]),
    ].join(" ");
    const lines = [
      [record.timestamp, identity, `stage=${record.stage}`, `operation=${record.operation}`, `status=${record.status}`]
        .filter((part) => part.length > 0)
        .join(" "),
    ];
    if (record.stdout !== undefined) {
      lines.push(`stdout:\n${redactSecret(this.secret, record.stdout)}`);
    }
    if (record.stderr !== undefined) {
      lines.push(`stderr:\n${redactSecret(this.secret, record.stderr)}`);
    }
    await appendFile(this.mainLogPath, `${lines.join("\n")}\n\n`);
  }
}
