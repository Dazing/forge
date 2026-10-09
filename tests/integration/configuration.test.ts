import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadConfiguration } from "../../apps/factory-cli/src/configuration.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("loads OpenAI subscription authentication and the configured model", async () => {
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
      openaiSubscription: {
        authFile: "./credentials/opencode-auth.json",
        modelId: "gpt-6-luna",
      },
      attemptTimeoutSeconds: 30,
      orchestrationTimeoutSeconds: 45,
      sharedSkills: ["./skills/standard"],
      roleSkills: {
        "test-design": ["./skills/test-design"],
        implementation: ["./skills/implementation"],
        refactor: [],
        review: ["./skills/review"],
        "acceptance-correction": ["./skills/test-design"],
        repair: ["./skills/implementation"],
        "re-review": ["./skills/review"],
        "pull-request": [],
      },
    }),
  );

  const configuration = await loadConfiguration(path);

  expect(configuration.authFile).toBe(join(directory, "credentials/opencode-auth.json"));
  expect(configuration.modelId).toBe("gpt-6-luna");
  expect(configuration.sandboxNetwork).toBe("host");
  expect(configuration.orchestrationTimeoutMs).toBe(45_000);
  expect(configuration.skills.byRole.implementation.at(-1)).toMatch(/skills\/implementation$/);
  expect(configuration.skills.byRole.review.at(-1)).toMatch(/skills\/review$/);
  expect(configuration.skills.byRole.review).not.toContain(configuration.skills.byRole.implementation.at(-1));
});
