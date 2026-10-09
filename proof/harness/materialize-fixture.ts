#!/usr/bin/env node
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { proofScenarioSchema } from "./scenario.js";

const execFileAsync = promisify(execFile);

export async function materializeFixture(repositoryRoot: string, scenarioPath: string, destination: string): Promise<void> {
  const root = resolve(repositoryRoot);
  const scenario = proofScenarioSchema.parse(JSON.parse(await readFile(resolve(root, scenarioPath), "utf8")));
  const fixture = resolve(root, scenario.fixture);
  const target = resolve(destination);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(fixture, target, {
    recursive: true,
    filter(source) {
      const name = basename(source);
      return name !== "bin" && name !== "obj" && name !== ".git";
    },
  });
  await writeFile(resolve(target, ".gitignore"), "bin/\nobj/\n**/bin/\n**/obj/\n.factory/verification-runtime/\n", "utf8");
  const git = async (...args: string[]): Promise<void> => {
    await execFileAsync("git", ["-C", target, ...args], { encoding: "utf8" });
  };
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Factory Fixture");
  await git("config", "user.email", "factory-fixture@invalid");
  await git("add", "--all");
  await git("commit", "--no-gpg-sign", "-m", `Fixture: ${scenario.id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [scenarioPath, destination] = process.argv.slice(2);
  if (!scenarioPath || !destination) {
    throw new Error("Usage: materialize-fixture <scenario.json> <destination>");
  }
  await materializeFixture(process.cwd(), scenarioPath, destination);
}
