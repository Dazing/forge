#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeTicket, parseTicket, type RunRequest } from "@factory/core";
import { createExecutionBackend } from "@factory/execution-backend";
import { GitWorkspace } from "@factory/git-workspace";
import { FileRunArtifacts } from "@factory/run-artifacts";
import { TrustedVerification } from "@factory/verification";
import { superviseProcess } from "@factory/orchestration-supervisor";
import { loadConfiguration, type FactoryConfiguration } from "./configuration.js";
import { loadFactoryRunStatus } from "./status.js";

interface RunArguments {
  readonly configPath: string;
  readonly ticketPath: string;
  readonly outputBranch: string;
  readonly runId: string;
}

interface StatusArguments {
  readonly configPath: string;
  readonly runId: string;
}

async function main(): Promise<number> {
  if (process.argv[2] === "status") {
    const args = parseStatusArguments(process.argv.slice(2));
    const configuration = await loadConfiguration(args.configPath);
    const status = await loadFactoryRunStatus(configuration, args.runId);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  const args = parseArguments(process.argv.slice(2));
  const configuration = await loadConfiguration(args.configPath);
  if (process.env.FACTORY_CLI_WORKER !== "1") {
    const scriptPath = fileURLToPath(import.meta.url);
    const result = await superviseProcess({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        scriptPath,
        "run",
        "--config",
        args.configPath,
        "--ticket",
        args.ticketPath,
        "--branch",
        args.outputBranch,
        "--run-id",
        args.runId,
      ],
      environment: { ...process.env, FACTORY_CLI_WORKER: "1" },
      diagnosticPath: resolve(configuration.runRoot, "evidence", args.runId, "supervisor.json"),
      initialTimeoutMs: Math.max(configuration.attemptTimeoutMs, configuration.orchestrationTimeoutMs) + 5_000,
    });
    return result.exitCode;
  }
  return runWorker(args, configuration);
}

async function runWorker(
  args: RunArguments,
  configuration: FactoryConfiguration,
): Promise<number> {
  const ticketPath = resolve(args.ticketPath);
  const ticket = parseTicket(ticketPath, await readFile(ticketPath, "utf8"));
  const abortController = new AbortController();
  const cancel = () => abortController.abort(new Error("Interrupted by supervisor or operator"));
  process.once("SIGINT", cancel);

  const workspaceRoot = resolve(configuration.runRoot, "workspaces");
  const evidenceRoot = resolve(configuration.runRoot, "evidence");
  const request: RunRequest = {
    runId: args.runId,
    ticket,
    repository: {
      sourcePath: configuration.sourceRepository,
      baseRef: configuration.baseRef,
      outputBranch: args.outputBranch,
      profilePath: configuration.repositoryProfile,
    },
    model: {
      provider: "openai-subscription",
      modelId: configuration.modelId,
    },
    attemptTimeoutMs: configuration.attemptTimeoutMs,
    orchestrationTimeoutMs: configuration.orchestrationTimeoutMs,
    skills: configuration.skills,
  };

  const artifacts = new FileRunArtifacts({
    rootDirectory: evidenceRoot,
    agentWorkspacePath: workspaceRoot,
    runId: args.runId,
    secretValues: [],
  });
  try {
    const outcome = await executeTicket(request, {
      workspace: new GitWorkspace({ workspaceRoot, signal: abortController.signal }),
      backend: createExecutionBackend({
        imageName: configuration.sandboxImage,
        authFile: configuration.authFile,
        modelId: configuration.modelId,
        artifactsPath: artifacts.runDirectory,
        attemptShutdownGraceMs: configuration.attemptShutdownGraceMs,
        ...(configuration.sandboxNetwork === undefined ? {} : { network: configuration.sandboxNetwork }),
      }),
      verification: new TrustedVerification({
        stateRoot: resolve(configuration.trustedRoot, args.runId),
        signal: abortController.signal,
      }),
      artifacts,
      progress(event) {
        process.stderr.write(`FACTORY_PROGRESS=${JSON.stringify(event)}\n`);
        process.send?.({ type: "progress", event });
      },
    }, abortController.signal);

    process.stdout.write(`${JSON.stringify({
      status: outcome.status,
      runId: outcome.runId,
      branch: outcome.outputBranch,
      finalCommit: outcome.finalCommit,
      report: outcome.reportPath,
      pullRequest: outcome.pullRequestPath,
      reason: outcome.terminalReason,
      reasonCode: outcome.terminalReasonCode,
    })}\n`);
    return outcome.status === "succeeded" ? 0 : outcome.status === "cancelled" ? 130 : 1;
  } finally {
    process.off("SIGINT", cancel);
  }
}

function parseArguments(argv: readonly string[]): RunArguments {
  if (argv[0] !== "run") {
    throw new Error("Usage: factory run --config <path> --ticket <path> --branch <new-branch> [--run-id <id>]");
  }
  const values = parseOptions(argv.slice(1));
  if (!values.config || !values.ticket || !values.branch) {
    throw new Error("--config, --ticket, and --branch are required");
  }
  return {
    configPath: values.config,
    ticketPath: values.ticket,
    outputBranch: values.branch,
    runId: values["run-id"] ?? randomUUID(),
  };
}

function parseStatusArguments(argv: readonly string[]): StatusArguments {
  const values = parseOptions(argv.slice(1));
  if (!values.config || !values["run-id"]) {
    throw new Error("Usage: factory status --config <path> --run-id <id>");
  }
  return { configPath: values.config, runId: values["run-id"] };
}

function parseOptions(argv: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error("Every CLI option requires a value");
    }
    values[name.slice(2)] = value;
  }
  return values;
}

main().then(
  (exitCode) => { process.exitCode = exitCode; },
  (error: unknown) => {
    process.stderr.write(`Factory configuration/infrastructure failure: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
