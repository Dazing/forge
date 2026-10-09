#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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

const execFileAsync = promisify(execFile);

async function runProof(configPath: string, scenarioPath: string, branch: string, runId: string): Promise<number> {
  const repositoryRoot = resolve(".");
  const scenario = proofScenarioSchema.parse(JSON.parse(await readFile(resolve(scenarioPath), "utf8")));
  const configuration = await loadConfiguration(configPath, process.env);
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
    standards: [
      ...configuration.standards,
      ...scenario.standards.map((path) => resolve(repositoryRoot, path)),
    ],
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
  });
  const backend = new FaultInjectingBackend(realBackend, scenario.faults);
  const outcome = await executeTicket(request, {
    workspace: new GitWorkspace({ workspaceRoot }),
    backend,
    verification: new TrustedVerification({ stateRoot: resolve(configuration.trustedRoot, runId) }),
    artifacts,
  });
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
process.exitCode = await runProof(configPath, scenarioPath, branch, suppliedRunId ?? randomUUID());
