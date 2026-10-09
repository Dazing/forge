import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfiguration } from "../../apps/factory-cli/src/configuration.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("loads the vLLM endpoint directly from the configuration file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-configuration-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "factory.json");
  await writeFile(
    path,
    JSON.stringify({
      sourceRepository: "./source",
      baseRef: "main",
      repositoryProfile: "./repository.json",
      runRoot: "./runs",
      trustedRoot: "./trusted",
      sandboxImage: "factory-agent:test",
      sandboxNetwork: "host",
      vllm: {
        endpoint: "http://vllm-host:8000/v1",
        modelId: "served-model",
      },
      attemptTimeoutSeconds: 30,
      orchestrationTimeoutSeconds: 45,
      standards: ["./standard.md"],
    }),
  );

  const configuration = await loadConfiguration(path);

  expect(configuration.endpoint).toBe("http://vllm-host:8000/v1");
  expect(configuration.sandboxNetwork).toBe("host");
  expect(configuration.orchestrationTimeoutMs).toBe(45_000);
});
