import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactEvent } from "@factory/core";
import type { FactoryConfiguration } from "./configuration.js";
import { loadFactoryRunStatus } from "./status.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadFactoryRunStatus", () => {
  it("reports the latest durable transition, observation, deadline, and transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-status-"));
    roots.push(root);
    const runDirectory = join(root, "evidence", "run-1");
    await mkdir(runDirectory, { recursive: true });
    const events: ArtifactEvent[] = [
      event(1, "run-started", "transition", "1970-01-01T00:00:01.000Z", {}),
      event(2, "attempt-transcript-ready", "transition", "1970-01-01T00:00:02.000Z", {
        transcriptPath: "/evidence/transcripts/implementation.log",
      }),
      {
        ...event(3, "attempt-runner-entered", "transition", "1970-01-01T00:00:03.000Z", {}),
        operationId: "implementation-1",
        deadlineAt: "1970-01-01T00:00:10.000Z",
        stage: "implementation",
        attempt: 1,
      },
      event(4, "attempt-status", "observation", "1970-01-01T00:00:04.000Z", { transcriptBytes: 42 }),
    ];
    await writeFile(join(runDirectory, "events.jsonl"), `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);
    await writeFile(join(runDirectory, "supervisor.json"), '{"timedOut":true,"endedAt":"1970-01-01T00:00:05.000Z"}\n');

    const status = await loadFactoryRunStatus(configuration(root), "run-1", () => 5_000);

    expect(status).toMatchObject({
      state: "terminated",
      elapsedMs: 4_000,
      remainingMs: 5_000,
      transcriptPath: "/evidence/transcripts/implementation.log",
      activeOperation: {
        type: "attempt-runner-entered",
        operationId: "implementation-1",
        stage: "implementation",
        attempt: 1,
      },
      lastObservation: { type: "attempt-status", details: { transcriptBytes: 42 } },
      supervisor: { timedOut: true, endedAt: "1970-01-01T00:00:05.000Z" },
    });
  });

  it("shows the actual correction rejection cause after a run finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-status-"));
    roots.push(root);
    const runDirectory = join(root, "evidence", "run-1");
    await mkdir(runDirectory, { recursive: true });
    const reason = "Acceptance correction violated protected workspace content: added .factory/probe/helper.mjs";
    const details = { status: "failed", reason, reasonCode: "correction-boundary-violation" };
    const events = [
      event(1, "run-started", "transition", "1970-01-01T00:00:01.000Z", {}),
      event(2, "run-finished", "transition", "1970-01-01T00:00:02.000Z", details),
    ];
    await writeFile(join(runDirectory, "events.jsonl"), `${events.map((item) => JSON.stringify(item)).join("\n")}\n`);

    const status = await loadFactoryRunStatus(configuration(root), "run-1", () => 3_000);

    expect(status.state).toBe("finished");
    expect(status.lastTransition?.details).toEqual(details);
    expect(JSON.stringify(status)).not.toContain("exhausted");
  });
});

function event(
  sequence: number,
  type: ArtifactEvent["type"],
  eventClass: ArtifactEvent["eventClass"],
  occurredAt: string,
  details: Readonly<Record<string, unknown>>,
): ArtifactEvent {
  return {
    schemaVersion: 1,
    sequence,
    runId: "run-1",
    occurredAt,
    runElapsedMs: sequence * 1_000,
    type,
    eventClass,
    details,
  };
}

function configuration(root: string): FactoryConfiguration {
  return {
    sourceRepository: "/source",
    baseRef: "main",
    repositoryProfile: "/profile.json",
    runRoot: root,
    trustedRoot: "/trusted",
    sandboxImage: "agent:test",
    authFile: "/opencode-auth.json",
    modelId: "model",
    attemptTimeoutMs: 1_000,
    orchestrationTimeoutMs: 1_000,
    attemptShutdownGraceMs: 100,
    skills: {
      shared: ["/standard"],
      byRole: {
        "test-design": [], implementation: [], refactor: [], review: [],
        "acceptance-correction": [], repair: [], "re-review": [], "pull-request": [],
      },
    },
  };
}
