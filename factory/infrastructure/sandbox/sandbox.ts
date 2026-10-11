import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { MountConfig, SandboxProvider } from "@ai-hero/sandcastle";
import { resolve } from "node:path";
import { modelsPath } from "../agent-runtime/models-path.js";
import { runCommand } from "../git-provider/git.js";
import { requirePath } from "../../shared/paths.js";

// Docker sandbox provider, read-only skill/model mounts, and image preflight.
// Mount sources are resolved from the repository root so added directory depth cannot redirect them.

export type AgentHarness = "pi" | "oh-my-pi";

export const IMAGE_NAME = "local-sandcastle-runner:latest";
export const dockerfilePath = "factory/infrastructure/sandbox/Dockerfile";

const checkMcpPath = resolve(import.meta.dirname, "check-mcp.mjs");
const maskedEnvPath = resolve(import.meta.dirname, "masked.env");

function sandboxMounts(harness: AgentHarness, factoryRoot: string, repositoryPath: string): MountConfig[] {
  const agentDir = harness === "pi" ? "/home/agent/.pi/agent" : "/home/agent/.omp/agent";
  return [
    { hostPath: resolve(factoryRoot, "factory/infrastructure/agent-runtime/skills"), sandboxPath: `${agentDir}/skills`, readonly: true },
    { hostPath: modelsPath, sandboxPath: `${agentDir}/${harness === "pi" ? "models.json" : "models.yml"}`, readonly: true },
    { hostPath: checkMcpPath, sandboxPath: "/home/agent/.pi/agent/check-mcp.mjs", readonly: true },
    // Head-mode planning mounts the factory checkout, including its REST credentials.
    // Shadow only the factory's .env; ticket repositories retain their own application config.
    ...(resolve(repositoryPath) === resolve(factoryRoot)
      ? [{ hostPath: maskedEnvPath, sandboxPath: "/home/agent/workspace/.env", readonly: true }]
      : []),
  ];
}

export function sandboxProvider(harness: AgentHarness, factoryRoot: string, repositoryPath: string): SandboxProvider {
  return docker({ imageName: IMAGE_NAME, network: "host", mounts: sandboxMounts(harness, factoryRoot, repositoryPath) });
}

/** Verify the runner image exists and every mount source is present before the daemon polls any ticket. */
export async function preflightSandbox(harness: AgentHarness, factoryRoot: string): Promise<void> {
  for (const mount of sandboxMounts(harness, factoryRoot, factoryRoot)) {
    await requirePath(mount.hostPath, "Sandbox mount source");
  }
  await runCommand("docker", ["image", "inspect", IMAGE_NAME], "checking the runner image");
}
