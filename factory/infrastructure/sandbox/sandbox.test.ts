import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { sandboxProvider } from "./sandbox.js";

test("handoff assets use Sandcastle-supported mount paths under the sandbox home", async () => {
  const controlPath = await mkdtemp(join(tmpdir(), "sandbox-handoff-mount-"));
  const contractPath = join(controlPath, "contract.json");
  const resultDirectoryPath = join(controlPath, "result");
  await writeFile(contractPath, "{}");
  await mkdir(resultDirectoryPath);
  const factoryRoot = resolve(import.meta.dirname, "../../..");

  assert.doesNotThrow(() => sandboxProvider("pi", factoryRoot, factoryRoot, { contractPath, resultDirectoryPath }));
});
