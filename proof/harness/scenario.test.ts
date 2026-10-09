import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { proofScenarioSchema } from "./scenario.js";

describe("proof scenarios", () => {
  it("reference loadable skill directories", async () => {
    const scenarioDirectory = resolve("proof/scenarios");
    const scenarioFiles = (await readdir(scenarioDirectory)).filter((file) => file.endsWith(".json"));

    for (const scenarioFile of scenarioFiles) {
      const scenario = proofScenarioSchema.parse(
        JSON.parse(await readFile(resolve(scenarioDirectory, scenarioFile), "utf8")),
      );

      for (const standard of scenario.standards) {
        const skillFile = resolve(standard, "SKILL.md");
        await expect(
          access(skillFile),
          `${scenarioFile} references an invalid skill directory: ${standard}`,
        ).resolves.toBeUndefined();
      }
    }
  });
});
