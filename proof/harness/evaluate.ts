#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDirectory } from "../../factory/shared/paths.js";
import { proofScenarioSchema } from "./scenario.js";

export async function evaluate(repositoryRoot: string, scenarioPath: string, candidateRepository: string): Promise<number> {
  const root = resolve(repositoryRoot);
  const scenario = proofScenarioSchema.parse(JSON.parse(await readFile(resolve(root, scenarioPath), "utf8")));
  const evaluator = resolve(root, scenario.evaluator);
  const candidate = resolve(candidateRepository);
  await requireDirectory(candidate, "Candidate repository");

  return await new Promise<number>((resolveExitCode, reject) => {
    const child = spawn(evaluator, [candidate], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`Evaluator terminated by signal ${signal}: ${evaluator}`));
        return;
      }
      resolveExitCode(code ?? 1);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [scenarioPath, candidateRepository] = process.argv.slice(2);
  if (!scenarioPath || !candidateRepository) {
    throw new Error("Usage: evaluate <scenario.json> <candidate-repository>");
  }
  process.exitCode = await evaluate(process.cwd(), scenarioPath, candidateRepository);
}
