#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { executeTicket, parseTicket, type RunRequest } from "@factory/core";
import { createExecutionBackend } from "@factory/execution-backend";
import { GitWorkspace } from "@factory/git-workspace";
import { FileRunArtifacts } from "@factory/run-artifacts";
import { TrustedVerification } from "@factory/verification";
import { loadConfiguration } from "../../apps/factory-cli/src/configuration.js";
import { FaultInjectingBackend } from "./fault-injecting-backend.js";
import { materializeFixture } from "./materialize-fixture.js";
import { proofScenarioSchema } from "./scenario.js";
import { superviseProcess } from "./process-supervisor.js";

const execFileAsync = promisify(execFile);

async function runProof(
  configPath: string,
  scenarioPath: string,
  branch: string,
  runId: string,
  signal: AbortSignal,
): Promise<number> {
  const repositoryRoot = resolve(".");
  const scenario = proofScenarioSchema.parse(JSON.parse(await readFile(resolve(scenarioPath), "utf8")));
  const configuration = await loadConfiguration(configPath);
  const proofRoot = resolve(configuration.runRoot, "proof-inputs", `${scenario.id}-${runId}`);
  const sourcePath = resolve(proofRoot, "source");
  await mkdir(dirname(sourcePath), { recursive: true });
  await materializeFixture(repositoryRoot, scenarioPath, sourcePath);
  const ticketPath = resolve(repositoryRoot, scenario.ticket);
  const workspaceRoot = resolve(configuration.runRoot, "workspaces");
  const evidenceRoot = resolve(configuration.runRoot, "evidence");
  const request: RunRequest = {
    runId,
    ticket: parseTicket(ticketPath, await readFile(ticketPath, "utf8")),
    repository: {
      sourcePath,
      baseRef: "main",
      outputBranch: branch,
      profilePath: configuration.repositoryProfile,
    },
    model: { provider: "vllm", modelId: configuration.modelId, endpoint: configuration.endpoint },
    attemptTimeoutMs: configuration.attemptTimeoutMs,
    orchestrationTimeoutMs: configuration.orchestrationTimeoutMs,
    standards: [...new Set([
      ...configuration.standards,
      ...scenario.standards.map((path) => resolve(repositoryRoot, path)),
    ])],
  };
  const artifacts = new FileRunArtifacts({
    rootDirectory: evidenceRoot,
    agentWorkspacePath: workspaceRoot,
    runId,
  });
  const realBackend = createExecutionBackend({
    imageName: configuration.sandboxImage,
    endpoint: configuration.endpoint,
    modelId: configuration.modelId,
    artifactsPath: artifacts.runDirectory,
    ...(configuration.sandboxNetwork === undefined ? {} : { network: configuration.sandboxNetwork }),
  });
  const backend = new FaultInjectingBackend(realBackend, scenario.faults);
  const outcome = await executeTicket(request, {
    workspace: new GitWorkspace({ workspaceRoot, signal }),
    backend,
    verification: new TrustedVerification({ stateRoot: resolve(configuration.trustedRoot, runId), signal }),
    artifacts,
    progress(event) {
      process.stderr.write(`FACTORY_PROGRESS=${JSON.stringify(event)}\n`);
      process.send?.({
        type: "progress",
        event,
        timeoutMs: progressTimeoutMs(event, request),
      });
    },
  }, signal);
  backend.assertAllFaultsRealized();

  const evaluator = resolve(repositoryRoot, scenario.evaluator);
  if (scenario.expectedSolution == null) {
    await execFileAsync(evaluator, [outcome.reportPath], { encoding: "utf8" });
  } else {
    if (outcome.status !== "succeeded") {
      throw new Error(`Proof ${scenario.id} failed before evaluation: ${outcome.terminalReason}`);
    }
    const checkout = resolve(proofRoot, "published-checkout");
    await rm(checkout, { recursive: true, force: true });
    await execFileAsync("git", ["clone", "--no-local", "--branch", branch, "--single-branch", sourcePath, checkout]);
    await execFileAsync(evaluator, [checkout], { encoding: "utf8" });
  }
  process.stdout.write(`${JSON.stringify({ scenario: scenario.id, status: outcome.status, branch, report: outcome.reportPath })}\n`);
  return outcome.status === "succeeded" || scenario.expectedSolution == null ? 0 : 1;
}

const [configPath, scenarioPath, branch, suppliedRunId] = process.argv.slice(2);
if (!configPath || !scenarioPath || !branch) {
  throw new Error(`Usage: ${basename(process.argv[1] ?? "run-proof")} <config> <scenario> <new-branch> [run-id]`);
}
const runId = suppliedRunId ?? randomUUID();
if (process.env.FACTORY_PROOF_WORKER === "1") {
  const abortController = new AbortController();
  const cancel = () => abortController.abort(new Error("Proof worker interrupted by supervisor"));
  process.once("SIGINT", cancel);
  try {
    process.exitCode = await runProof(configPath, scenarioPath, branch, runId, abortController.signal);
  } finally {
    process.off("SIGINT", cancel);
  }
} else {
  const configuration = await loadConfiguration(configPath);
  const scriptPath = fileURLToPath(import.meta.url);
  const result = await superviseProcess({
    command: process.execPath,
    args: ["--import", "tsx", scriptPath, configPath, scenarioPath, branch, runId],
    environment: { ...process.env, FACTORY_PROOF_WORKER: "1" },
    diagnosticPath: resolve(configuration.runRoot, "evidence", runId, "supervisor.json"),
    initialTimeoutMs: configuration.attemptTimeoutMs + 5_000,
  });
  process.exitCode = result.exitCode;
}

function progressTimeoutMs(event: { readonly type: string; readonly details: Readonly<Record<string, unknown>> }, request: RunRequest): number {
  const graceMs = 5_000;
  if (event.type === "workspace-snapshot-started" || event.type === "stage-checkpoint-started") {
    return (request.orchestrationTimeoutMs ?? 60_000) + graceMs;
  }
  if (event.type === "attempt-execution-started" && typeof event.details.deadline === "number") {
    return Math.max(graceMs, event.details.deadline - Date.now() + graceMs);
  }
  return request.attemptTimeoutMs + graceMs;
}
