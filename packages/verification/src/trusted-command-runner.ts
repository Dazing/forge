import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CheckResult } from "@factory/core";
import type { TrustedCommand } from "./repository-profile.js";

const TEST_RESULT_PREFIX = "FACTORY_TEST_RESULT=";
const MAX_OUTPUT_BYTES = 1024 * 1024;

const testCaseSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  failureKind: z.enum(["assertion", "infrastructure"]).optional(),
  criteria: z.array(z.string().min(1)).optional(),
}).strict();

const testSummarySchema = z.object({
  discovered: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  tests: z.array(testCaseSchema),
}).strict();

export type TestSummary = z.infer<typeof testSummarySchema>;

export interface CommandContext {
  readonly workspace: string;
  readonly baseline: string;
  readonly suite: string;
  readonly runnerConfig: string;
  readonly scratch: string;
}

export interface CommandExecution {
  readonly check: CheckResult;
  readonly summary?: TestSummary;
  readonly processProblem?: string;
}

export class TrustedCommandRunner {
  readonly #evidenceDirectory: string;
  readonly #signal: AbortSignal | undefined;
  #sequence = 0;

  constructor(evidenceDirectory: string, signal?: AbortSignal) {
    this.#evidenceDirectory = evidenceDirectory;
    this.#signal = signal;
  }

  async run(
    command: TrustedCommand,
    context: CommandContext,
    cwd: string,
    treeId: string,
    acceptanceDigest?: string,
  ): Promise<CommandExecution> {
    this.#signal?.throwIfAborted();
    await mkdir(this.#evidenceDirectory, { recursive: true, mode: 0o700 });
    const args = command.args.map((argument) => renderArgument(argument, context));
    const displayCommand = [command.executable, ...args].map((part) => JSON.stringify(part)).join(" ");
    const environment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CI: "true",
      HOME: join(context.scratch, "home"),
      TMPDIR: join(context.scratch, "tmp"),
      DOTNET_CLI_HOME: join(context.scratch, "dotnet"),
      NUGET_PACKAGES: join(context.scratch, "nuget"),
    };
    await Promise.all([
      mkdir(environment.HOME, { recursive: true }),
      mkdir(environment.TMPDIR, { recursive: true }),
      mkdir(environment.DOTNET_CLI_HOME, { recursive: true }),
      mkdir(environment.NUGET_PACKAGES, { recursive: true }),
    ]);

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let exceededOutput = false;
    let spawnError: Error | undefined;

    const child = spawn(command.executable, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const append = (destination: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        exceededOutput = true;
        child.kill("SIGTERM");
        return;
      }
      if (destination === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

    const terminate = (): void => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 500);
      force.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, command.timeoutMs);
    timeout.unref();
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    this.#signal?.addEventListener("abort", onAbort, { once: true });

    const exitCode = await new Promise<number>((resolveExit) => {
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code) => resolveExit(code ?? 1));
    });
    clearTimeout(timeout);
    this.#signal?.removeEventListener("abort", onAbort);

    const effectiveExitCode = timedOut ? 124 : cancelled ? 130 : exceededOutput ? 125 : exitCode;
    const artifactPath = join(this.#evidenceDirectory, `${String(++this.#sequence).padStart(4, "0")}-${command.id}.log`);
    const processProblem = timedOut
      ? `Trusted command ${command.id} exceeded its ${command.timeoutMs}ms deadline`
      : cancelled
        ? `Trusted command ${command.id} was cancelled`
        : exceededOutput
          ? `Trusted command ${command.id} exceeded the ${MAX_OUTPUT_BYTES}-byte output limit`
          : spawnError
            ? `Trusted command ${command.id} could not start: ${spawnError.message}`
            : undefined;
    const output = [`$ ${displayCommand}`, stdout, stderr, processProblem ?? ""].filter(Boolean).join("\n");
    await writeFile(artifactPath, output, { encoding: "utf8", mode: 0o600 });
    await chmod(artifactPath, 0o400);

    let summary: TestSummary | undefined;
    let summaryProblem: string | undefined;
    if (command.testResults && !processProblem) {
      const parsed = parseTestSummary(stdout);
      if (parsed instanceof Error) summaryProblem = parsed.message;
      else summary = parsed;
    }
    const check: CheckResult = {
      command: command.id,
      exitCode: effectiveExitCode,
      ...(summary ? { discoveredTests: summary.discovered, skippedTests: summary.skipped } : {}),
      outputArtifact: artifactPath,
      treeId,
      ...(acceptanceDigest ? { acceptanceDigest } : {}),
    };
    const finalProblem = processProblem ?? summaryProblem;
    return {
      check,
      ...(summary ? { summary } : {}),
      ...(finalProblem ? { processProblem: finalProblem } : {}),
    };
  }
}

function parseTestSummary(stdout: string): TestSummary | Error {
  const candidates = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(TEST_RESULT_PREFIX));
  if (candidates.length !== 1) {
    return new Error(`Trusted test command must emit exactly one ${TEST_RESULT_PREFIX} structured test result`);
  }
  try {
    const parsedJson: unknown = JSON.parse(candidates[0]!.slice(TEST_RESULT_PREFIX.length));
    const parsed = testSummarySchema.safeParse(parsedJson);
    if (!parsed.success) return new Error(`Invalid structured test result: ${z.prettifyError(parsed.error)}`);
    const summary = parsed.data;
    if (summary.discovered !== summary.tests.length) {
      return new Error(`Structured test result discovered ${summary.discovered} tests but reported ${summary.tests.length}`);
    }
    const actualSkipped = summary.tests.filter((test) => test.status === "skipped").length;
    if (summary.skipped !== actualSkipped) {
      return new Error(`Structured test result declared ${summary.skipped} skipped tests but reported ${actualSkipped}`);
    }
    const identifiers = new Set<string>();
    for (const test of summary.tests) {
      if (identifiers.has(test.id)) return new Error(`Structured test result contains duplicate test identifier ${test.id}`);
      identifiers.add(test.id);
      if (test.status === "failed" && !test.failureKind) {
        return new Error(`Failed test ${test.id} must identify assertion or infrastructure failure`);
      }
      if (test.status !== "failed" && test.failureKind) {
        return new Error(`Non-failing test ${test.id} cannot declare a failure kind`);
      }
    }
    return summary;
  } catch (error) {
    return new Error(`Cannot parse structured test result: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function renderArgument(argument: string, context: CommandContext): string {
  const rendered = argument
    .replaceAll("{workspace}", context.workspace)
    .replaceAll("{baseline}", context.baseline)
    .replaceAll("{suite}", context.suite)
    .replaceAll("{runnerConfig}", context.runnerConfig);
  if (/\{[A-Za-z][A-Za-z0-9]*\}/.test(rendered)) {
    throw new Error(`Trusted command argument contains an unknown placeholder: ${argument}`);
  }
  return rendered;
}

