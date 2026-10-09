import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AttemptRequest, ExecutionBackendPort } from "@factory/core";
import { FaultInjectingBackend } from "./fault-injecting-backend.js";

const request = {
  runId: "run",
  stage: "implementation",
  attempt: 1,
  attemptId: "run-implementation-1",
  sessionId: "fresh-session",
  workspacePath: "/workspace",
  deadline: Date.now() + 1_000,
  context: {
    ticket: { path: "ticket.md", markdown: "ticket", digest: "digest", kind: "feature", criteria: [{ id: "AC-1", text: "works" }] },
    stage: "implementation",
    attempt: 1,
    baseCommit: "base",
    snapshotId: "tree",
    standards: [],
    priorReports: [],
    failureEvidence: [],
  },
  correction: false,
} satisfies AttemptRequest;

describe("FaultInjectingBackend", () => {
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
            status: "completed",
            stage: attempt.stage,
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
      stage: "implementation",
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
});
