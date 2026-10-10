import { resolve } from "node:path";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { requirePath } from "../shared/paths.js";

export type AgentHarness = "pi" | "oh-my-pi";

export const IMAGE_NAME = "local-sandcastle-runner:latest";
export const dockerfilePath = resolve(import.meta.dirname, "Dockerfile");

const runnerRoot = resolve(import.meta.dirname, "..");
const skillsPath = resolve(runnerRoot, "..", "standards/skills");
const modelsPath = resolve(runnerRoot, "harness/models.json");
const checkMcpPath = resolve(import.meta.dirname, "check-mcp.mjs");

/** Docker sandbox provider for one harness: image, host networking, and the read-only agent mounts. */
export function sandboxProvider(harness: AgentHarness): SandboxProvider {
  const agentDir = `/home/agent/.${harness === "pi" ? "pi" : "omp"}/agent`;
  return docker({
    imageName: IMAGE_NAME,
    network: "host",
    mounts: [
      { hostPath: skillsPath, sandboxPath: `${agentDir}/skills`, readonly: true },
      { hostPath: modelsPath, sandboxPath: `${agentDir}/${harness === "pi" ? "models.json" : "models.yml"}`, readonly: true },
      ...(harness === "pi" ? [{ hostPath: checkMcpPath, sandboxPath: `${agentDir}/check-mcp.mjs`, readonly: true }] : []),
    ],
  });
}

/** Verify every mount source exists before any sandbox starts; Docker fails late and opaquely otherwise. */
export async function preflightSandbox(harness: AgentHarness): Promise<void> {
  const skills = await requirePath(skillsPath, "Skills source");
  if (!skills.isDirectory()) {
    throw new Error(`Skills source is not a directory: ${skillsPath}`);
  }
  await requirePath(modelsPath, "Model configuration");
  if (harness === "pi") {
    await requirePath(checkMcpPath, "MCP preflight script");
  }
}

export async function requireCleanSandbox(
  sandbox: { exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> },
  stage: string,
): Promise<void> {
  const status = await sandbox.exec("git status --porcelain");
  if (status.exitCode !== 0) {
    throw new Error(`${stage} could not inspect the worktree: ${status.stderr.trim()}`);
  }
  if (status.stdout.trim().length > 0) {
    throw new Error(`${stage} left uncommitted changes in the branch worktree.`);
  }
}
