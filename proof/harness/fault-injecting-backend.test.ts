import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AttemptOutcome, AttemptRequest, ExecutionBackendPort } from "@factory/core";
import { FaultInjectingBackend } from "./fault-injecting-backend.js";

const request = {
  runId: "run",
  stage: "implementation",
  operation: "implementation",
  attempt: 1,
  attemptId: "run-implementation-1",
  sessionId: "fresh-session",
  workspacePath: "/workspace",
  deadline: Number.MAX_SAFE_INTEGER,
  context: {
    ticket: { path: "ticket.md", markdown: "ticket", digest: "digest", kind: "feature", criteria: [{ id: "AC-1", text: "works" }] },
    stage: "implementation",
    operation: "implementation",
    attempt: 1,
    baseCommit: "base",
    snapshotId: "tree",
    standards: [],
    reportReferences: [],
    evidenceBundles: [],
  },
  candidateReadonly: false,
} satisfies AttemptRequest;

const fault = {
  operation: "implementation",
  attempt: 1,
  point: "after-agent-files-changed",
  outcome: "execution-failure",
} as const;

function changingBackend(change: () => Promise<void>): ExecutionBackendPort {
  return {
    async runAttempt(attempt): Promise<AttemptOutcome> {
      await change();
      return {
        status: "completed",
        attemptId: attempt.attemptId,
        sessionId: attempt.sessionId,
        report: {
          kind: "authoring",
          status: "completed",
          stage: "implementation",
          operation: "implementation",
          criteria: [],
          evidence: ["green"],
          changedWork: "files changed",
          unresolvedIssues: [],
        },
        evidence: ["agent-transcript"],
      };
    },
    async runPullRequestAttempt() { throw new Error("Unexpected pull-request attempt"); },
    async stopAttempt() {},
  };
}

describe("FaultInjectingBackend", () => {
  it("runs an attempt without inspecting the workspace when no fault applies", async () => {
    const backend: ExecutionBackendPort = {
      async runAttempt(attempt) {
        return {
          status: "execution-failure",
          attemptId: attempt.attemptId,
          sessionId: attempt.sessionId,
          error: "backend reached",
          evidence: ["backend-transcript"],
        };
      },
      async runPullRequestAttempt() { throw new Error("Unexpected pull-request attempt"); },
      async stopAttempt() {},
    };
    const root = await mkdtemp(join(tmpdir(), "fault-bypass-"));
    try {
      const result = await new FaultInjectingBackend(backend, []).runAttempt(
        { ...request, workspacePath: join(root, "not-materialized") },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ error: "backend reached", evidence: ["backend-transcript"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces only the configured completed attempt after preserving its evidence", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "fault-backend-"));
    const backend: ExecutionBackendPort = {
      async runAttempt(attempt) {
        await writeFile(join(workspacePath, "changed.txt"), "agent change\n");
        return {
          status: "completed",
          attemptId: attempt.attemptId,
          sessionId: attempt.sessionId,
          report: {
            kind: "authoring",
            status: "completed",
            stage: "implementation",
            operation: "implementation",
            criteria: [{ id: "AC-1", verdict: "met", evidence: ["green"] }],
            evidence: ["green"],
            changedWork: "files changed",
            unresolvedIssues: [],
          },
          evidence: ["agent-transcript"],
        };
      },
      async runPullRequestAttempt() {
        throw new Error("Pull-request attempts are not exercised by this fault test");
      },
      async stopAttempt() {},
    };
    const injected = new FaultInjectingBackend(backend, [{
      operation: "implementation",
      attempt: 1,
      point: "after-agent-files-changed",
      outcome: "execution-failure",
    }]);

    const result = await injected.runAttempt(
      { ...request, workspacePath },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ status: "execution-failure", sessionId: "fresh-session" });
    expect(result.evidence).toEqual(["agent-transcript", "fault:implementation:1:after-agent-files-changed"]);
    expect(() => injected.assertAllFaultsRealized()).not.toThrow();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("does not count scratch or build output changes as agent source changes", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "fault-outputs-"));
    try {
      const backend = changingBackend(async () => {
        for (const directory of [".factory/verification-runtime/tmp", "src/Api/bin", "src/Api/obj"]) {
          await mkdir(join(workspacePath, directory), { recursive: true });
          await writeFile(join(workspacePath, directory, "generated"), "runtime output");
        }
      });
      await expect(new FaultInjectingBackend(backend, [fault]).runAttempt(
        { ...request, workspacePath }, new AbortController().signal,
      )).rejects.toThrow("required a changed workspace");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("hashes source changes without opening a leftover diagnostic FIFO", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "fault-fifo-"));
    try {
      execFileSync("mkfifo", [join(workspacePath, "clr-debug-pipe-in")]);
      const backend = changingBackend(() => writeFile(join(workspacePath, "source.txt"), "changed"));
      const result = await new FaultInjectingBackend(backend, [fault]).runAttempt(
        { ...request, workspacePath }, new AbortController().signal,
      );
      expect(result).toMatchObject({
        status: "execution-failure",
        evidence: ["agent-transcript", "fault:implementation:1:after-agent-files-changed"],
      });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it.each(["cancelled", "timeout"] as const)("does not start a faulted attempt after %s", async (status) => {
    const workspacePath = await mkdtemp(join(tmpdir(), "fault-stopped-"));
    try {
      const controller = new AbortController();
      if (status === "cancelled") controller.abort(new Error("operator stopped"));
      let started = false;
      const backend = changingBackend(async () => { started = true; });
      const result = await new FaultInjectingBackend(backend, [fault]).runAttempt(
        { ...request, workspacePath, deadline: status === "timeout" ? Date.now() - 1 : request.deadline },
        controller.signal,
      );
      expect(result.status).toBe(status);
      expect(started).toBe(false);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("preserves agent evidence and leaves the fault unrealized when cancelled before the after-digest", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "fault-cancelled-"));
    try {
      const controller = new AbortController();
      const backend = changingBackend(async () => {
        await writeFile(join(workspacePath, "source.txt"), "changed");
        controller.abort(new Error("operator stopped"));
      });
      const injected = new FaultInjectingBackend(backend, [fault]);
      const result = await injected.runAttempt({ ...request, workspacePath }, controller.signal);
      expect(result).toMatchObject({ status: "cancelled", evidence: ["agent-transcript"] });
      expect(() => injected.assertAllFaultsRealized()).toThrow("implementation:1");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
