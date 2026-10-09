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
  it("terminates a silent worker and records its last durable transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestration-supervisor-"));
    temporaryDirectories.push(root);
    const worker = join(root, "worker.mjs");
    const diagnosticPath = join(root, "evidence", "supervisor.json");
    await writeFile(worker, `
process.on("SIGINT", () => process.exit(130));
process.send?.({
  type: "progress",
  event: {
    schemaVersion: 1, sequence: 1, runId: "run-1",
    occurredAt: new Date().toISOString(), runElapsedMs: 0,
    type: "attempt-runner-entered", eventClass: "transition",
    operationId: "implementation-1",
    deadlineAt: new Date(Date.now() + 25).toISOString(),
    details: {}
  }
});
process.stdin.resume();
`, "utf8");

    const result = await superviseProcess({
      command: process.execPath,
      args: [worker],
      environment: process.env,
      diagnosticPath,
      initialTimeoutMs: 1_000,
      watchdogGraceMs: 0,
      killGraceMs: 25,
    });
    const diagnostic = JSON.parse(await readFile(diagnosticPath, "utf8")) as Record<string, unknown>;

    expect(result).toMatchObject({ exitCode: 130, timedOut: true, diagnosticPath });
    expect(diagnostic).toMatchObject({
      schemaVersion: 2,
      exitCode: 130,
      timedOut: true,
      lastTransition: { type: "attempt-runner-entered", operationId: "implementation-1" },
      diagnosticReason: "Active operation exceeded its absolute deadline",
    });
  });

  it("records observations without allowing them to extend the active deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestration-supervisor-"));
    temporaryDirectories.push(root);
    const worker = join(root, "worker.mjs");
    const diagnosticPath = join(root, "evidence", "supervisor.json");
    await writeFile(worker, `
process.on("SIGINT", () => process.exit(130));
const base = {
  schemaVersion: 1, runId: "run-1", occurredAt: new Date().toISOString(),
  runElapsedMs: 0, operationId: "implementation-1", details: {}
};
process.send?.({ type: "progress", event: {
  ...base, sequence: 1, type: "attempt-runner-entered", eventClass: "transition",
  deadlineAt: new Date(Date.now() + 50).toISOString()
}});
let sequence = 2;
setInterval(() => process.send?.({ type: "progress", event: {
  ...base, sequence: sequence++, type: "attempt-status", eventClass: "observation"
}}), 5);
`, "utf8");

    const result = await superviseProcess({
      command: process.execPath,
      args: [worker],
      environment: process.env,
      diagnosticPath,
      initialTimeoutMs: 1_000,
      watchdogGraceMs: 0,
      killGraceMs: 25,
    });
    const diagnostic = JSON.parse(await readFile(diagnosticPath, "utf8")) as Record<string, unknown>;

    expect(result.timedOut).toBe(true);
    expect(diagnostic).toMatchObject({
      lastTransition: { type: "attempt-runner-entered" },
      lastObservation: { type: "attempt-status" },
    });
  });
});
