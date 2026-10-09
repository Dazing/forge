import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactEvent, RunEventType, RunOutcome } from "@factory/core";
import { FileRunArtifacts } from "./file-run-artifacts.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "run-artifacts-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function event(type: RunEventType, sequence: number, details: Record<string, unknown> = {}): ArtifactEvent {
  return {
    schemaVersion: 1,
    sequence,
    runId: "run-42",
    occurredAt: new Date(sequence).toISOString(),
    runElapsedMs: sequence,
    type,
    eventClass: "transition",
    details: { sequence, ...details },
  };
}

function failedOutcome(): Omit<RunOutcome, "reportPath"> {
  return {
    status: "failed",
    runId: "run-42",
    baseCommit: "base123",
    outputBranch: "factory/run-42",
    attempts: [{
      stage: "implementation",
      attempt: 2,
      sessionId: "session-recovery",
      status: "execution-failure",
      evidence: ["events.jsonl#2"],
    }],
    repairRoundsUsed: 0,
    findings: [],
    criteria: [{ id: "AC-1", verdict: "unmet", evidence: ["check failed"] }],
    terminalReason: "Recovery attempt failed its trusted checks",
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileRunArtifacts", () => {
  it("rejects traversal, absolute attachment paths, and evidence directories inside the agent workspace", async () => {
    const hostRoot = await temporaryDirectory();
    const workspace = await temporaryDirectory();
    const artifacts = new FileRunArtifacts({ rootDirectory: hostRoot, agentWorkspacePath: workspace, runId: "run-42" });

    await expect(artifacts.attach("../stolen.txt", "no")).rejects.toThrow(/safe relative path/i);
    await expect(artifacts.attach("nested/../../stolen.txt", "no")).rejects.toThrow(/safe relative path/i);
    await expect(artifacts.attach(join(hostRoot, "absolute.txt"), "no")).rejects.toThrow(/safe relative path/i);
    expect(() => new FileRunArtifacts({
      rootDirectory: join(workspace, "evidence"),
      agentWorkspacePath: workspace,
      runId: "run-42",
    })).toThrow(/outside the agent workspace/i);
  });

  it("redacts configured secrets plus endpoint credentials and queries from every text output", async () => {
    const hostRoot = await temporaryDirectory();
    const workspace = await temporaryDirectory();
    const artifacts = new FileRunArtifacts({
      rootDirectory: hostRoot,
      agentWorkspacePath: workspace,
      runId: "run-42",
      secretValues: ["super-secret"],
    });
    const endpoint = "https://alice:password@example.test/v1/chat?api_key=super-secret&trace=yes";

    await artifacts.record(event("run-started", 1, {
      endpoint,
      model: { id: "model-a", token: "super-secret" },
    }));
    const attachment = await artifacts.attach("logs/attempt.txt", `called ${endpoint}\ntoken=super-secret`);
    const reportPath = await artifacts.finalize(failedOutcome());

    const serialized = [
      await readFile(join(hostRoot, "run-42", "events.jsonl"), "utf8"),
      await readFile(attachment, "utf8"),
      await readFile(reportPath, "utf8"),
      await readFile(join(hostRoot, "run-42", "report.md"), "utf8"),
    ].join("\n");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("trace=yes");
    expect(serialized).toContain("https://example.test/v1/chat");
    expect(serialized).toContain("[REDACTED]");
  });

  it("appends concurrently recorded events in invocation order without rewriting prior lines", async () => {
    const hostRoot = await temporaryDirectory();
    const workspace = await temporaryDirectory();
    const artifacts = new FileRunArtifacts({ rootDirectory: hostRoot, agentWorkspacePath: workspace, runId: "run-42" });

    await Promise.all(Array.from({ length: 20 }, (_, sequence) => artifacts.record(event("attempt-status", sequence))));
    const eventPath = join(hostRoot, "run-42", "events.jsonl");
    const before = await readFile(eventPath, "utf8");
    await artifacts.record(event("attempt-status", 20));
    const after = await readFile(eventPath, "utf8");
    const events = after.trimEnd().split("\n").map((line) => JSON.parse(line) as ArtifactEvent);

    expect(after.startsWith(before)).toBe(true);
    expect(events.map((item) => item.details.sequence)).toEqual(Array.from({ length: 21 }, (_, index) => index));
  });

  it("writes an accurate failed report with identities, criteria, attempts, model, and recovery evidence", async () => {
    const hostRoot = await temporaryDirectory();
    const workspace = await temporaryDirectory();
    const artifacts = new FileRunArtifacts({ rootDirectory: hostRoot, agentWorkspacePath: workspace, runId: "run-42" });
    await artifacts.record(event("attempt-report-rejected", 1, {
      model: { provider: "vllm", modelId: "qwen-coder", temperature: 0 },
      correction: { accepted: false, reason: "changed original intent" },
    }));

    const reportPath = await artifacts.finalize(failedOutcome());
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      outcome: Omit<RunOutcome, "reportPath">;
      events: ArtifactEvent[];
    };
    const markdown = await readFile(join(hostRoot, "run-42", "report.md"), "utf8");

    expect(report.outcome).toEqual(failedOutcome());
    expect(report.outcome).not.toHaveProperty("finalCommit");
    expect(report.events[0]?.details).toMatchObject({
      model: { provider: "vllm", modelId: "qwen-coder", temperature: 0 },
      correction: { accepted: false },
    });
    expect(markdown).toContain("**Status:** failed");
    expect(markdown).toContain("Recovery attempt failed its trusted checks");
    expect(markdown).toContain("AC-1: unmet");
    expect(markdown).toContain("implementation attempt 2: execution-failure");
    expect(markdown).toContain("attempt-report-rejected");
  });

  it("preserves correction boundary diagnostics with no checks in events and both final reports", async () => {
    const hostRoot = await temporaryDirectory();
    const workspace = await temporaryDirectory();
    const artifacts = new FileRunArtifacts({ rootDirectory: hostRoot, agentWorkspacePath: workspace, runId: "run-42" });
    const reason = "Acceptance correction violated protected workspace content: added .factory/probe/helper.mjs";
    const diagnostics = {
      policy: "protected-workspace-content",
      exclusions: [".git", ".factory/acceptance", ".factory/verification-runtime"],
      beforeIdentity: "before-digest",
      afterIdentity: "after-digest",
      added: [".factory/probe/helper.mjs"],
      modified: [],
      deleted: [],
      binding: { runId: "run-42", ticketDigest: "ticket", baseCommit: "base123", suiteVersion: "suite-1", suiteDigest: "suite-digest" },
    };
    const details = { gate: "acceptance-correction", passed: false, checks: [], reason, reasonCode: "correction-boundary-violation", diagnostics };
    await artifacts.record(event("gate-finished", 1, details));
    const reportPath = await artifacts.finalize({
      ...failedOutcome(),
      terminalReason: reason,
      terminalReasonCode: "correction-boundary-violation",
    });

    const report = JSON.parse(await readFile(reportPath, "utf8")) as { outcome: RunOutcome; events: ArtifactEvent[] };
    const persistedEvent = JSON.parse((await readFile(join(hostRoot, "run-42/events.jsonl"), "utf8")).trim()) as ArtifactEvent;
    const markdown = await readFile(join(hostRoot, "run-42/report.md"), "utf8");

    expect(persistedEvent.details).toMatchObject(details);
    expect(report.events[0]?.details).toMatchObject(details);
    expect(report.outcome.terminalReasonCode).toBe("correction-boundary-violation");
    expect(markdown).toContain(reason);
    expect(markdown).toContain("**Terminal reason code:** correction-boundary-violation");
    expect(markdown).toContain("before-digest");
    expect(markdown).toContain("after-digest");
    expect(markdown).toContain("protected-workspace-content");
    expect(markdown).toContain("suite-digest");
    expect(markdown).not.toContain("exhausted");
  });

  it("atomically publishes both final outputs and leaves no temporary files", async () => {
    const hostRoot = await temporaryDirectory();
    const workspace = await temporaryDirectory();
    const artifacts = new FileRunArtifacts({ rootDirectory: hostRoot, agentWorkspacePath: workspace, runId: "run-42" });
    await artifacts.record(event("run-finished", 1));

    const reportPath = await artifacts.finalize(failedOutcome());
    const runDirectory = join(hostRoot, "run-42");
    const names = await readdir(runDirectory);

    expect(reportPath).toBe(join(runDirectory, "report.json"));
    expect(names).toEqual(expect.arrayContaining(["events.jsonl", "report.json", "report.md"]));
    expect(names.some((name) => name.includes(".tmp-"))).toBe(false);
    await expect(artifacts.record(event("run-finished", 2))).rejects.toThrow(/finalized/i);
    await expect(artifacts.attach("late.txt", "too late")).rejects.toThrow(/finalized/i);
    await expect(artifacts.finalize(failedOutcome())).rejects.toThrow(/finalized/i);
  });

  it("enforces the configured attachment size limit and never overwrites an attachment", async () => {
    const hostRoot = await temporaryDirectory();
    const workspace = await temporaryDirectory();
    const artifacts = new FileRunArtifacts({
      rootDirectory: hostRoot,
      agentWorkspacePath: workspace,
      runId: "run-42",
      maxArtifactBytes: 4,
    });

    await expect(artifacts.attach("large.txt", "12345")).rejects.toThrow(/exceeds.*4 bytes/i);
    await artifacts.attach("same.txt", "one");
    await expect(artifacts.attach("same.txt", "two")).rejects.toThrow(/attach.*same\.txt/i);
  });
});
