import { describe, expect, it } from "vitest";
import type { ArtifactEvent, RunArtifactsPort } from "./contracts.js";
import { RunEventWriter } from "./run-event-writer.js";

describe("RunEventWriter", () => {
  it("serializes concurrent events and publishes exactly the durable payload", async () => {
    const durable: ArtifactEvent[] = [];
    const live: ArtifactEvent[] = [];
    const artifacts: RunArtifactsPort = {
      async record(event) {
        await Promise.resolve();
        durable.push(event);
      },
      async attach() { return "unused"; },
      async finalize() { return "unused"; },
    };
    let now = 1_000;
    const writer = new RunEventWriter({
      runId: "run-1",
      artifacts,
      progress: (event) => live.push(event),
      now: () => now++,
    });

    await Promise.all([
      writer.emit({ type: "preflight-started", eventClass: "transition", details: { operationId: "preflight" } }),
      writer.emit({ type: "preflight-finished", eventClass: "transition", details: { operationId: "preflight", passed: true, checkCount: 2 } }),
      writer.emit({ type: "run-finalizing", eventClass: "transition", details: { status: "succeeded", reason: "done" } }),
    ]);

    expect(durable.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(live).toEqual(durable);
    expect(durable.map(({ occurredAt }) => occurredAt)).toEqual([
      "1970-01-01T00:00:01.001Z",
      "1970-01-01T00:00:01.002Z",
      "1970-01-01T00:00:01.003Z",
    ]);
    expect(durable.map(({ runElapsedMs }) => runElapsedMs)).toEqual([1, 2, 3]);
  });

  it("does not publish a live event when durable recording fails", async () => {
    const live: ArtifactEvent[] = [];
    const writer = new RunEventWriter({
      runId: "run-1",
      artifacts: {
        async record() { throw new Error("disk full"); },
        async attach() { return "unused"; },
        async finalize() { return "unused"; },
      },
      progress: (event) => live.push(event),
      now: () => 1_000,
    });

    await expect(writer.emit({
      type: "preflight-started",
      eventClass: "transition",
      details: { operationId: "preflight" },
    })).rejects.toThrow("disk full");
    expect(live).toEqual([]);
  });
});
