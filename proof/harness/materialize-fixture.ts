#!/usr/bin/env node
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { proofScenarioSchema } from "./scenario.js";

const execFileAsync = promisify(execFile);

export async function materializeFixture(repositoryRoot: string, scenarioPath: string): Promise<string> {
  const root = resolve(repositoryRoot);
  const scenario = proofScenarioSchema.parse(JSON.parse(await readFile(resolve(root, scenarioPath), "utf8")));
  const fixture = resolve(root, scenario.fixture);
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const target = resolve(root, ".run", `${scenario.id}-${timestamp}`);

  await mkdir(dirname(target), { recursive: true });
  await mkdir(target);

  try {
    await cp(fixture, target, {
      recursive: true,
      filter(source) {
        const name = basename(source);
        return name !== "bin" && name !== "obj" && name !== ".git";
      },
    });
    await writeFile(resolve(target, ".gitignore"), "bin/\nobj/\n**/bin/\n**/obj/\n", "utf8");

    const git = async (...args: string[]): Promise<void> => {
      await execFileAsync("git", ["-C", target, ...args], { encoding: "utf8" });
    };
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Sandcastle Fixture");
    await git("config", "user.email", "sandcastle-fixture@invalid");
    await git("add", "--all");
    await git("commit", "--no-gpg-sign", "-m", `Fixture: ${scenario.id}`);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }

  return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [scenarioPath, ...unexpectedArguments] = process.argv.slice(2);
  if (!scenarioPath || unexpectedArguments.length > 0) {
    throw new Error("Usage: materialize-fixture <scenario.json>");
  }
  const target = await materializeFixture(process.cwd(), scenarioPath);
  console.log(target);
}
