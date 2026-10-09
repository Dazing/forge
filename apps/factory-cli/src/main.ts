#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeTicket, parseTicket, type RunRequest } from "@factory/core";
import { createExecutionBackend } from "@factory/execution-backend";
import { GitWorkspace } from "@factory/git-workspace";
import { FileRunArtifacts } from "@factory/run-artifacts";
import { TrustedVerification } from "@factory/verification";
import { loadConfiguration } from "./configuration.js";

interface Arguments {
  readonly configPath: string;
  readonly ticketPath: string;
  readonly outputBranch: string;
  readonly runId: string;
}

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  const configuration = await loadConfiguration(args.configPath, process.env);
  const ticketPath = resolve(args.ticketPath);
  const ticket = parseTicket(ticketPath, await readFile(ticketPath, "utf8"));
  const abortController = new AbortController();
  const cancel = () => abortController.abort(new Error("Interrupted by SIGINT"));
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
      provider: "vllm",
      modelId: configuration.modelId,
      endpoint: configuration.endpoint,
    },
    attemptTimeoutMs: configuration.attemptTimeoutMs,
    standards: configuration.standards,
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
        endpoint: configuration.endpoint,
        modelId: configuration.modelId,
        artifactsPath: artifacts.runDirectory,
      }),
      verification: new TrustedVerification({
        stateRoot: resolve(configuration.trustedRoot, args.runId),
        signal: abortController.signal,
      }),
      artifacts,
    }, abortController.signal);

    process.stdout.write(`${JSON.stringify({
      status: outcome.status,
      runId: outcome.runId,
      branch: outcome.outputBranch,
      finalCommit: outcome.finalCommit,
      report: outcome.reportPath,
      reason: outcome.terminalReason,
    })}\n`);
    return outcome.status === "succeeded" ? 0 : outcome.status === "cancelled" ? 130 : 1;
  } finally {
    process.off("SIGINT", cancel);
  }
}

function parseArguments(argv: readonly string[]): Arguments {
  if (argv[0] !== "run") {
    throw new Error("Usage: factory run --config <path> --ticket <path> --branch <new-branch> [--run-id <id>]");
  }
  const values: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error("Every CLI option requires a value");
    }
    values[name.slice(2)] = value;
  }
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

main().then(
  (exitCode) => { process.exitCode = exitCode; },
  (error: unknown) => {
    process.stderr.write(`Factory configuration/infrastructure failure: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
