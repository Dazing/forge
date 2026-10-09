import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ArtifactEvent } from "@factory/core";

export interface SupervisorProgress {
  readonly type: "progress";
  readonly event: ArtifactEvent;
}

export interface ProcessSupervisorOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly diagnosticPath: string;
  readonly initialTimeoutMs: number;
  readonly killGraceMs?: number;
  readonly watchdogGraceMs?: number;
  readonly now?: () => Date;
}

export interface ProcessSupervisorResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly diagnosticPath: string;
}

export async function superviseProcess(options: ProcessSupervisorOptions): Promise<ProcessSupervisorResult> {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock();
  const child = spawn(options.command, [...options.args], {
    env: options.environment,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  let timedOut = false;
  let activeDeadlineMs = startedAt.getTime() + options.initialTimeoutMs;
  let lastTransition: ArtifactEvent | undefined;
  let lastObservation: ArtifactEvent | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let forcedKill: NodeJS.Timeout | undefined;
  let interruptSentAt: string | undefined;
  let killSentAt: string | undefined;
  let diagnosticReason: string | undefined;

  const interrupt = (reason: string): void => {
    if (interruptSentAt !== undefined) return;
    timedOut = true;
    diagnosticReason = reason;
    interruptSentAt = clock().toISOString();
    child.kill("SIGINT");
    forcedKill = setTimeout(() => {
      killSentAt = clock().toISOString();
      child.kill("SIGKILL");
    }, options.killGraceMs ?? 5_000);
    forcedKill.unref();
  };

  const armWatchdog = (): void => {
    clearTimeout(watchdog);
    const remainingMs = activeDeadlineMs + (options.watchdogGraceMs ?? 5_000) - clock().getTime();
    if (remainingMs <= 0) {
      queueMicrotask(() => interrupt("Active operation exceeded its absolute deadline"));
      return;
    }
    watchdog = setTimeout(
      () => interrupt("Active operation exceeded its absolute deadline"),
      Math.min(remainingMs, 2_147_483_647),
    );
    watchdog.unref();
  };

  child.on("message", (message: unknown) => {
    if (!isSupervisorProgress(message)) return;
    const event = message.event;
    if (event.eventClass === "observation") {
      lastObservation = event;
      return;
    }
    lastTransition = event;
    if (event.type === "attempt-shutdown-stalled") {
      activeDeadlineMs = clock().getTime();
      interrupt("Attempt shutdown was not confirmed");
      return;
    }
    if (event.deadlineAt !== undefined) {
      const deadline = Date.parse(event.deadlineAt);
      if (Number.isFinite(deadline)) {
        activeDeadlineMs = deadline;
        armWatchdog();
      }
    }
  });
  armWatchdog();

  const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("error", closed.reject);
  child.once("close", (code, signal) => closed.resolve({ code, signal }));
  const { code, signal } = await closed.promise;
  clearTimeout(watchdog);
  clearTimeout(forcedKill);

  const exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  const endedAt = clock();
  const diagnostic = {
    schemaVersion: 2,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    workerPid: child.pid,
    exitCode,
    signal,
    timedOut,
    activeDeadlineAt: new Date(activeDeadlineMs).toISOString(),
    lastTransition,
    lastObservation,
    interruptSentAt,
    killSentAt,
    diagnosticReason,
  };
  await writeDiagnostic(options.diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
  return { exitCode, signal, timedOut, diagnosticPath: options.diagnosticPath };
}

function isSupervisorProgress(value: unknown): value is SupervisorProgress {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SupervisorProgress>;
  const event = candidate.event as Partial<ArtifactEvent> | undefined;
  return candidate.type === "progress"
    && typeof event === "object"
    && event !== null
    && event.schemaVersion === 1
    && typeof event.type === "string"
    && (event.eventClass === "transition" || event.eventClass === "observation");
}

async function writeDiagnostic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
