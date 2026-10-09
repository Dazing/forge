import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { superviseProcess } from "./process-supervisor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("superviseProcess", () => {
  it("terminates a silent worker and records its last progress outside the worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "proof-supervisor-"));
    temporaryDirectories.push(root);
    const worker = join(root, "worker.mjs");
    const diagnosticPath = join(root, "evidence", "supervisor.json");
    await writeFile(worker, `
process.on("SIGINT", () => process.exit(130));
process.send?.({
  type: "progress",
  event: { type: "stage-checkpoint-started", stage: "implementation" },
  timeoutMs: 25
});
process.stdin.resume();
`, "utf8");

    // This integration test exercises a separate OS process; Vitest fake timers cannot drive its supervisor deadline.
    const result = await superviseProcess({
      command: process.execPath,
      args: [worker],
      environment: process.env,
      diagnosticPath,
      initialTimeoutMs: 1_000,
      killGraceMs: 25,
    });
    const diagnostic = JSON.parse(await readFile(diagnosticPath, "utf8")) as Record<string, unknown>;

    expect(result).toMatchObject({ exitCode: 130, timedOut: true, diagnosticPath });
    expect(diagnostic).toMatchObject({
      exitCode: 130,
      timedOut: true,
      timeoutMs: 25,
      lastProgress: { type: "stage-checkpoint-started", stage: "implementation" },
    });
  });
});
