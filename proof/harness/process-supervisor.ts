import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SupervisorProgress {
  readonly type: "progress";
  readonly event: unknown;
  readonly timeoutMs: number;
}

export interface ProcessSupervisorOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly diagnosticPath: string;
  readonly initialTimeoutMs: number;
  readonly killGraceMs?: number;
  readonly now?: () => Date;
}

export interface ProcessSupervisorResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly diagnosticPath: string;
}

export async function superviseProcess(options: ProcessSupervisorOptions): Promise<ProcessSupervisorResult> {
  const startedAt = (options.now ?? (() => new Date()))();
  const child = spawn(options.command, [...options.args], {
    env: options.environment,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  let timedOut = false;
  let timeoutMs = options.initialTimeoutMs;
  let lastProgress: unknown;
  let watchdog: NodeJS.Timeout | undefined;
  let forcedKill: NodeJS.Timeout | undefined;

  const armWatchdog = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGINT");
      forcedKill = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? 5_000);
      forcedKill.unref();
    }, timeoutMs);
    watchdog.unref();
  };
  child.on("message", (message: unknown) => {
    if (!isSupervisorProgress(message)) return;
    lastProgress = message.event;
    timeoutMs = message.timeoutMs;
    armWatchdog();
  });
  armWatchdog();

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(watchdog);
  clearTimeout(forcedKill);

  const exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  const endedAt = (options.now ?? (() => new Date()))();
  const diagnostic = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    exitCode,
    signal,
    timedOut,
    timeoutMs,
    lastProgress,
  };
  await writeDiagnostic(options.diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
  return { exitCode, signal, timedOut, diagnosticPath: options.diagnosticPath };
}

function isSupervisorProgress(value: unknown): value is SupervisorProgress {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SupervisorProgress>;
  return candidate.type === "progress"
    && Number.isSafeInteger(candidate.timeoutMs)
    && (candidate.timeoutMs ?? 0) > 0;
}

async function writeDiagnostic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
