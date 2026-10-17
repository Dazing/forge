import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { BindMountCreateOptions, BindMountSandboxHandle, BindMountSandboxProvider } from "@ai-hero/sandcastle";
import { preflightSandbox, sandboxProvider, type AgentHarness } from "./sandbox.js";

// The provider is exercised through the real docker process boundary: a shim `docker`
// on PATH records the argv of every invocation, so assertions observe the effective
// `-v` volume specs (source, destination, read-only flag) the container receives.

const fakeDockerShim = `#!/bin/sh
sep=$(printf '\\037')
line=""
for arg in "$@"; do line="$line$arg$sep"; done
printf '%s\\n' "$line" >> "$FAKE_DOCKER_ARGS_LOG"
if [ "$1" = "run" ]; then echo fake-container; fi
exit 0
`;

type HandoffPaths = { contractPath: string; resultDirectoryPath: string };

async function makeHandoffPaths(): Promise<HandoffPaths> {
  const controlPath = await mkdtemp(join(tmpdir(), "sandbox-handoff-mount-"));
  const contractPath = join(controlPath, "contract.json");
  const resultDirectoryPath = join(controlPath, "result");
  await writeFile(contractPath, "{}");
  await mkdir(resultDirectoryPath);
  return { contractPath, resultDirectoryPath };
}

async function makeFactoryRoot(options: { modelsCatalog: boolean }): Promise<string> {
  const factoryRoot = await mkdtemp(join(tmpdir(), "sandbox-factory-root-"));
  await mkdir(join(factoryRoot, "factory/infrastructure/agent-runtime/skills"), { recursive: true });
  if (options.modelsCatalog) {
    await writeFile(join(factoryRoot, "models.json"), JSON.stringify({ providers: { "fixture-provider": {} } }));
  }
  return factoryRoot;
}

/** Launch the harness sandbox against a shim `docker` and return the volume specs from its `docker run` argv. */
async function mountsWithFakeDocker(
  harness: AgentHarness,
  factoryRoot: string,
  repositoryPath: string,
  ticketWorkspace: string,
  handoff: HandoffPaths,
): Promise<string[]> {
  const binDir = await mkdtemp(join(tmpdir(), "fake-docker-bin-"));
  const argsLog = join(binDir, "docker-args.log");
  await writeFile(join(binDir, "docker"), fakeDockerShim);
  await chmod(join(binDir, "docker"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.FAKE_DOCKER_ARGS_LOG = argsLog;
  try {
    const provider = sandboxProvider(harness, factoryRoot, repositoryPath, handoff) as
      & BindMountSandboxProvider
      & { create: (options: BindMountCreateOptions) => Promise<BindMountSandboxHandle> };
    const handle = await provider.create({
      worktreePath: ticketWorkspace,
      hostRepoPath: ticketWorkspace,
      mounts: [{ hostPath: ticketWorkspace, sandboxPath: "/home/agent/workspace" }],
      env: {},
    });
    await handle.close();
  } finally {
    process.env.PATH = previousPath;
    delete process.env.FAKE_DOCKER_ARGS_LOG;
  }
  const runLine = (await readFile(argsLog, "utf8")).split("\n").find((line) => line.split("\x1f")[0] === "run");
  assert.ok(runLine !== undefined, "expected the provider to launch the container with docker run");
  const args = runLine.split("\x1f");
  const specs: string[] = [];
  for (let index = 0; index + 1 < args.length; index += 1) {
    if (args[index] === "-v") specs.push(args[index + 1]!);
  }
  return specs;
}

for (const harness of ["pi", "oh-my-pi"] as const) {
  test(`mounts the root model catalog read-only at the ${harness} native destination from the supplied factory root`, async () => {
    const factoryRoot = await makeFactoryRoot({ modelsCatalog: true });
    const ticketWorkspace = await mkdtemp(join(tmpdir(), "sandbox-ticket-workspace-"));
    const specs = await mountsWithFakeDocker(harness, factoryRoot, ticketWorkspace, ticketWorkspace, await makeHandoffPaths());

    const nativeDestination = harness === "pi" ? "/home/agent/.pi/agent/models.json" : "/home/agent/.omp/agent/models.yml";
    assert.ok(
      specs.includes(`${join(factoryRoot, "models.json")}:${nativeDestination}:ro,z`),
      `expected the root catalog mounted read-only at ${nativeDestination}, got: ${specs.join(" ")}`,
    );
    assert.ok(
      !specs.some((spec) => spec.startsWith(`${join(factoryRoot, "factory/infrastructure/agent-runtime/models.json")}:`)),
      "the removed runtime-location catalog must not be mounted",
    );
    assert.ok(
      !specs.some((spec) => spec.startsWith(`${resolve(process.cwd(), "models.json")}:`)),
      "the catalog source must come from the supplied factory root, not the process working directory",
    );
  });
}

test("handoff assets use Sandcastle-supported mount paths under the sandbox home", async () => {
  const factoryRoot = await makeFactoryRoot({ modelsCatalog: true });
  const ticketWorkspace = await mkdtemp(join(tmpdir(), "sandbox-ticket-workspace-"));
  const handoff = await makeHandoffPaths();
  const specs = await mountsWithFakeDocker("pi", factoryRoot, ticketWorkspace, ticketWorkspace, handoff);

  assert.ok(specs.includes(`${handoff.contractPath}:/home/agent/.factory-handoff/contract.json:ro,z`));
  assert.ok(specs.includes(`${handoff.resultDirectoryPath}:/home/agent/.factory-handoff/result:z`));
  assert.ok(
    !specs.some((spec) => spec.includes(":/home/agent/workspace/.env")),
    "a ticket workspace outside the factory checkout must keep its own application configuration",
  );
});

test("the factory checkout sandbox shadows its .env with the empty credential overlay", async () => {
  const factoryRoot = resolve(import.meta.dirname, "../../..");
  const handoff = await makeHandoffPaths();
  const specs = await mountsWithFakeDocker("pi", factoryRoot, factoryRoot, factoryRoot, handoff);

  assert.ok(specs.includes(`${join(factoryRoot, "factory/infrastructure/sandbox/masked.env")}:/home/agent/workspace/.env:ro,z`));
});

for (const harness of ["pi", "oh-my-pi"] as const) {
  test(`preflight rejects a missing root model catalog for ${harness} without falling back to the runtime location`, async () => {
    const fixtureRoot = await makeFactoryRoot({ modelsCatalog: false });
    await writeFile(join(fixtureRoot, "factory/infrastructure/agent-runtime/models.json"), JSON.stringify({ legacy: true }));

    await assert.rejects(() => preflightSandbox(harness, fixtureRoot), (error: Error) => {
      const missingRootPath = join(fixtureRoot, "models.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(error.message, new RegExp(`Sandbox mount source does not exist: ${missingRootPath}$`));
      assert.ok(!error.message.includes("agent-runtime"), "preflight must name the root catalog, never the removed runtime location");
      return true;
    });
  });
}
