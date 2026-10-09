import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttemptRequest,
  PullRequestAttemptRequest,
  StageReport,
} from "@factory/core";
import {
  ExecutionBackend,
  type RunnerInvocation,
  type SandcastleAttemptRunner,
} from "./execution-backend.js";

const report: StageReport = {
  kind: "authoring",
  status: "completed",
  stage: "implementation",
  operation: "implementation",
  criteria: [{ id: "criterion-1", verdict: "met", evidence: ["tests passed"] }],
  evidence: ["tests passed"],
  changedWork: "Implemented the requested behavior.",
  unresolvedIssues: [],
};

interface FixturePaths {
  readonly workspacePath: string;
  readonly artifactsPath: string;
  readonly authFile: string;
  readonly standardsPath: string;
  readonly suitePath: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<FixturePaths> {
  const root = await mkdtemp(join(tmpdir(), "execution-backend-"));
  temporaryRoots.push(root);
  const workspacePath = join(root, "workspace");
  const artifactsPath = join(root, "artifacts");
  const authFile = join(root, "opencode-auth.json");
  const standardsPath = join(root, "protected", "skills", "test-standard");
  const suitePath = join(root, "protected", "acceptance");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(standardsPath, { recursive: true });
  await mkdir(suitePath, { recursive: true });
  await writeFile(
    join(standardsPath, "SKILL.md"),
    "---\nname: test-standard\ndescription: Test standard\n---\n\nApply this standard.",
  );
  await writeFile(authFile, JSON.stringify({
    openai: { type: "oauth", refresh: "test-refresh", access: "test-access", expires: 4_102_444_800_000 },
  }));
  return { workspacePath, artifactsPath, authFile, standardsPath, suitePath };
}

function request(paths: FixturePaths, overrides: Partial<AttemptRequest> = {}): AttemptRequest {
  const stage = overrides.stage ?? "implementation";
  const attempt = overrides.attempt ?? 1;
  const context = overrides.context ?? {
    ticket: {
      path: "ticket.md",
      markdown: "# Ticket\n\nImplement it.",
      digest: "ticket-digest",
      kind: "feature" as const,
      criteria: [{ id: "criterion-1", text: "It works" }],
    },
    stage,
    operation: overrides.operation ?? stage,
    attempt,
    baseCommit: "original-base-commit",
    snapshotId: "current-tree",
    standards: [paths.standardsPath],
    acceptanceSuite: {
      version: "1",
      digest: "suite-digest",
      path: paths.suitePath,
    },
    reportReferences: [],
    evidenceBundles: [],
  };

  return {
    runId: "run-1",
    stage,
    operation: overrides.operation ?? stage,
    attempt,
    attemptId: "implementation-1",
    sessionId: "session-1",
    workspacePath: paths.workspacePath,
    deadline: Date.now() + 10_000,
    candidateReadonly: false,
    context,
    ...overrides,
  };
}

function pullRequestRequest(paths: FixturePaths): PullRequestAttemptRequest {
  return {
    runId: "run-1",
    attempt: 1,
    attemptId: "pull-request-1",
    sessionId: "pull-request-session-1",
    workspacePath: paths.workspacePath,
    deadline: Date.now() + 10_000,
    context: {
      ticket: {
        path: "ticket.md",
        markdown: "# Ticket\n\nImplement it.",
        digest: "ticket-digest",
        kind: "feature",
        criteria: [{ id: "criterion-1", text: "It works" }],
      },
      baseCommit: "original-base-commit",
      snapshotId: "verified-tree",
      standards: [paths.standardsPath],
      reportReferences: [],
      evidenceBundles: [],
    },
  };
}

function successfulRunner(
  invocations: RunnerInvocation[],
  runtimeSessionIds: string[] = ["runtime-session-1", "runtime-session-2"],
): SandcastleAttemptRunner {
  return {
    async run(invocation) {
      invocations.push(invocation);
      return {
        report,
        runtimeSessionId: runtimeSessionIds[invocations.length - 1] ?? `runtime-${invocations.length}`,
        evidence: [invocation.transcriptPath],
      };
    },
  };
}

async function backend(paths: FixturePaths, runner: SandcastleAttemptRunner) {
  return new ExecutionBackend(
    {
      imageName: "local-software-factory-agent:test",
      authFile: paths.authFile,
      modelId: "test-model",
      artifactsPath: paths.artifactsPath,
    },
    runner,
  );
}

describe("ExecutionBackend", () => {
  it("gives each normal and correction attempt isolated writable scratch without workspace or input changes", async () => {
    const paths = await fixture();
    const scratchPaths: string[] = [];
    const adapter = await backend(paths, {
      async run(invocation) {
        const scratch = invocation.scratch;
        scratchPaths.push(scratch.hostPath);
        expect(scratch.readonly).toBe(false);
        expect(scratch.sandboxPath).toBe("/home/agent/factory-scratch");
        expect(invocation.prompt).toContain(scratch.sandboxPath);
        expect(scratch.hostPath.startsWith(`${paths.workspacePath}/`)).toBe(false);
        expect(await readdir(scratch.hostPath)).toEqual([]);
        await writeFile(join(scratch.hostPath, "probe.js"), "console.log(11 - 4);");
        expect(await readFile(join(scratch.hostPath, "probe.js"), "utf8")).toContain("11 - 4");
        // Cleanup must not follow worker-created links into protected input.
        await symlink(paths.standardsPath, join(scratch.hostPath, "input-link"));
        expect(await readdir(paths.workspacePath)).toEqual([]);
        expect(invocation.mounts.every((mount) => mount.readonly)).toBe(true);
        return {
          report: { ...report, stage: "test-design", operation: scratchPaths.length === 1 ? "test-design" : "acceptance-correction" },
          runtimeSessionId: `scratch-session-${scratchPaths.length}`,
          evidence: [],
        };
      },
    });

    for (const correction of [false, true]) {
      const operation = correction ? "acceptance-correction" : "test-design";
      const outcome = await adapter.runAttempt(request(paths, {
        stage: "test-design",
        operation,
        context: {
          ...request(paths).context,
          stage: "test-design",
          operation,
        },
        attemptId: `test-design-${correction}`,
        sessionId: `test-design-session-${correction}`,
      }), new AbortController().signal);
      expect(outcome.status).toBe("completed");
    }
    expect(new Set(scratchPaths).size).toBe(2);
    for (const path of scratchPaths) {
      await expect(stat(dirname(path))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readdir(paths.workspacePath)).toEqual([]);
    expect(await readFile(join(paths.standardsPath, "SKILL.md"), "utf8")).toContain("Apply this standard.");
  });

  it("removes scratch after runner failure", async () => {
    const paths = await fixture();
    let scratchPath = "";
    const adapter = await backend(paths, {
      async run(invocation) {
        scratchPath = invocation.scratch.hostPath;
        await writeFile(join(scratchPath, "probe.js"), "throw new Error('probe');");
        throw new Error("runner failed");
      },
    });
    await expect(adapter.runAttempt(request(paths), new AbortController().signal))
      .resolves.toMatchObject({ status: "execution-failure" });
    await expect(stat(dirname(scratchPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps scratch writable until cancelled runner settlement is confirmed", async () => {
    const paths = await fixture();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const caller = new AbortController();
    let scratchPath = "";
    const adapter = await backend(paths, {
      async run(invocation) {
        scratchPath = invocation.scratch.hostPath;
        started.resolve();
        await finish.promise;
        throw invocation.signal.reason;
      },
    });
    const outcome = adapter.runAttempt(request(paths), caller.signal);
    await started.promise;
    caller.abort();
    await writeFile(join(scratchPath, "shutdown.txt"), "still stopping");
    finish.resolve();
    await expect(outcome).resolves.toMatchObject({ status: "cancelled" });
    await expect(stat(dirname(scratchPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["active-mount", "inspection-failed"] as const)(
    "retains scratch and the original outcome when runtime release is uncertain: %s",
    async (condition) => {
      const paths = await fixture();
      let scratchPath = "";
      const adapter = await backend(paths, {
        async run(invocation) {
          scratchPath = invocation.scratch.hostPath;
          temporaryRoots.push(dirname(scratchPath));
          await writeFile(join(scratchPath, "probe.js"), "console.log('probe');");
          throw new Error("original runner failure");
        },
        async canRemoveScratch() {
          if (condition === "inspection-failed") throw new Error("Docker is unavailable");
          return false;
        },
      });
      const outcome = await adapter.runAttempt(request(paths), new AbortController().signal);
      expect(outcome).toMatchObject({
        status: "execution-failure",
        error: expect.stringContaining("original runner failure"),
      });
      expect(await readFile(join(scratchPath, "probe.js"), "utf8")).toContain("probe");
      expect(await readFile(outcome.evidence[0]!, "utf8")).toContain("runtime mount release could not be confirmed");
    },
  );

  it.each(["workspacePath", "suitePath"] as const)(
    "rejects a temporary directory symlink into %s before runner entry",
    async (target) => {
      const paths = await fixture();
      const alias = join(dirname(paths.workspacePath), "temporary-alias");
      await symlink(paths[target], alias);
      const originalEntries = await readdir(paths[target]);
      const invocations: RunnerInvocation[] = [];
      const adapter = await backend(paths, successfulRunner(invocations));
      vi.stubEnv("TMPDIR", alias);
      try {
        const outcome = await adapter.runAttempt(request(paths), new AbortController().signal);
        expect(outcome).toMatchObject({
          status: "execution-failure",
          error: expect.stringContaining("Scratch must be disjoint"),
        });
        expect(invocations).toEqual([]);
        expect(await readdir(paths[target])).toEqual(originalEntries);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );


  it("starts one fresh run with a distinct orchestration and runtime session identity per invocation", async () => {
    const paths = await fixture();
    const invocations: RunnerInvocation[] = [];
    const adapter = await backend(paths, successfulRunner(invocations));

    const first = await adapter.runAttempt(request(paths), new AbortController().signal);
    const second = await adapter.runAttempt(
      request(paths, { attemptId: "implementation-2", attempt: 2, sessionId: "session-2" }),
      new AbortController().signal,
    );

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(invocations).toHaveLength(2);
    expect(invocations.map(({ sessionId }) => sessionId)).toEqual(["session-1", "session-2"]);
    expect(invocations.every(({ branchStrategy }) => branchStrategy.type === "head")).toBe(true);
    expect(invocations[0]?.branchStrategy).toEqual({ type: "head" });
  });

  it("creates the transcript before runner entry and emits safe lifecycle boundaries", async () => {
    const paths = await fixture();
    const observed: string[] = [];
    let transcriptAtEntry = "";
    const runner: SandcastleAttemptRunner = {
      async run(invocation) {
        transcriptAtEntry = await readFile(invocation.transcriptPath, "utf8");
        return {
          report,
          runtimeSessionId: "runtime-session-transcript",
          evidence: [invocation.transcriptPath],
        };
      },
    };
    const adapter = await backend(paths, runner);

    const outcome = await adapter.runAttempt(
      request(paths),
      new AbortController().signal,
      async (event) => { observed.push(event.type); },
    );

    expect(outcome.status).toBe("completed");
    expect(transcriptAtEntry).toContain("lifecycle: transcript-ready");
    expect(transcriptAtEntry).toContain("attempt: implementation-1");
    expect(transcriptAtEntry).not.toContain("Implement it.");
    expect(observed).toEqual(expect.arrayContaining([
      "attempt-transcript-ready",
      "attempt-runner-entered",
      "attempt-runner-finished",
    ]));
    const transcript = outcome.evidence[0];
    expect(transcript).toBeDefined();
    await expect(stat(transcript!)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it("redacts original and refreshed subscription credentials from the finalized transcript", async () => {
    const paths = await fixture();
    const runner: SandcastleAttemptRunner = {
      async run(invocation) {
        await appendFile(invocation.transcriptPath, "\nold=test-access refresh=test-refresh");
        await writeFile(paths.authFile, JSON.stringify({
          openai: {
            type: "oauth",
            refresh: "refreshed-token",
            access: "new-access-token",
            expires: 4_102_444_800_000,
          },
        }));
        await appendFile(invocation.transcriptPath, "\nnew=new-access-token refresh=refreshed-token");
        return {
          report,
          runtimeSessionId: "runtime-session-redaction",
          evidence: [invocation.transcriptPath],
        };
      },
    };
    const adapter = await backend(paths, runner);

    const outcome = await adapter.runAttempt(request(paths), new AbortController().signal);

    expect(outcome.status).toBe("completed");
    const transcriptPath = outcome.evidence[0];
    expect(transcriptPath).toBeDefined();
    const transcript = await readFile(transcriptPath!, "utf8");
    expect(transcript).not.toContain("test-access");
    expect(transcript).not.toContain("test-refresh");
    expect(transcript).not.toContain("new-access-token");
    expect(transcript).not.toContain("refreshed-token");
    expect(transcript).toContain("[REDACTED]");
  });

  it("reports first agent activity and bounded transcript metadata without stream content", async () => {
    const paths = await fixture();
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const observed: Array<{ type: string; details: Readonly<Record<string, unknown>> }> = [];
    const runner: SandcastleAttemptRunner = {
      async run(invocation) {
        invocation.onAgentActivity?.();
        started.resolve();
        await finish.promise;
        return {
          report,
          runtimeSessionId: "runtime-session-activity",
          evidence: [invocation.transcriptPath],
        };
      },
    };
    const adapter = new ExecutionBackend({
      imageName: "local-software-factory-agent:test",
      authFile: paths.authFile,
      modelId: "test-model",
      artifactsPath: paths.artifactsPath,
      statusIntervalMs: 5,
    }, runner);
    const outcomePromise = adapter.runAttempt(
      request(paths),
      new AbortController().signal,
      async ({ type, details }) => { observed.push({ type, details }); },
    );
    await started.promise;
    await vi.advanceTimersByTimeAsync(5);
    finish.resolve();
    await outcomePromise;

    expect(observed.filter(({ type }) => type === "attempt-agent-activity-started")).toHaveLength(1);
    expect(observed.some(({ type }) => type === "attempt-status")).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("Implement it.");
  });

  it("rejects reuse of either an orchestration session identity or an OpenCode runtime session", async () => {
    const paths = await fixture();
    const invocations: RunnerInvocation[] = [];
    const adapter = await backend(
      paths,
      successfulRunner(invocations, ["runtime-session-reused", "runtime-session-reused"]),
    );

    await expect(adapter.runAttempt(request(paths), new AbortController().signal)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(
      adapter.runAttempt(
        request(paths, { attemptId: "implementation-2", attempt: 2, sessionId: "session-1" }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "execution-failure" });
    await expect(
      adapter.runAttempt(
        request(paths, { attemptId: "implementation-3", attempt: 2, sessionId: "session-3" }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "execution-failure", error: expect.stringContaining("runtime session") });
    expect(invocations).toHaveLength(2);
  });

  it("aborts at the deadline and waits for runner shutdown before returning", async () => {
    const paths = await fixture();
    vi.useFakeTimers();
    let stopped = false;
    const start = Promise.withResolvers<void>();
    const runner: SandcastleAttemptRunner = {
      run(invocation) {
        start.resolve();
        const { promise, reject } = Promise.withResolvers<never>();
        invocation.signal.addEventListener(
          "abort",
          () => {
            queueMicrotask(() => {
              stopped = true;
              reject(invocation.signal.reason);
            });
          },
          { once: true },
        );
        return promise;
      },
    };
    const adapter = await backend(paths, runner);

    const outcomePromise = adapter.runAttempt(
      request(paths, { deadline: Date.now() + 10 }),
      new AbortController().signal,
    );
    await start.promise;
    await vi.advanceTimersByTimeAsync(10);
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("timeout");
    expect(stopped).toBe(true);
  });

  it("returns shutdown-stalled when an aborted runner ignores the shutdown grace", async () => {
    const paths = await fixture();
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
    let scratchPath = "";
    const events: string[] = [];
    const runner: SandcastleAttemptRunner = {
      run(invocation) {
        scratchPath = invocation.scratch.hostPath;
        temporaryRoots.push(dirname(scratchPath));
        started.resolve();
        return Promise.withResolvers<never>().promise;
      },
    };
    const adapter = new ExecutionBackend({
      imageName: "local-software-factory-agent:test",
      authFile: paths.authFile,
      modelId: "test-model",
      artifactsPath: paths.artifactsPath,
      attemptShutdownGraceMs: 5,
    }, runner);
    const outcomePromise = adapter.runAttempt(
      request(paths, { deadline: Date.now() + 10 }),
      new AbortController().signal,
      async (event) => { events.push(event.type); },
    );
    await started.promise;

    await vi.advanceTimersByTimeAsync(15);
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("shutdown-stalled");
    expect(events).toEqual(expect.arrayContaining([
      "attempt-deadline-reached",
      "attempt-abort-requested",
      "attempt-shutdown-stalled",
      "attempt-runner-finished",
    ]));
    expect(events).not.toContain("attempt-shutdown-confirmed");
    await writeFile(join(scratchPath, "still-running.txt"), "scratch retained");
    expect(await readFile(join(scratchPath, "still-running.txt"), "utf8")).toBe("scratch retained");
  });

  it("stopAttempt aborts the run and confirms shutdown before it returns", async () => {
    const paths = await fixture();
    let stopped = false;
    const start = Promise.withResolvers<void>();
    const runner: SandcastleAttemptRunner = {
      run(invocation) {
        start.resolve();
        const { promise, reject } = Promise.withResolvers<never>();
        invocation.signal.addEventListener(
          "abort",
          () => {
            queueMicrotask(() => {
              stopped = true;
              reject(invocation.signal.reason);
            });
          },
          { once: true },
        );
        return promise;
      },
    };
    const adapter = await backend(paths, runner);
    const run = adapter.runAttempt(request(paths), new AbortController().signal);
    await start.promise;

    await adapter.stopAttempt("implementation-1");

    expect(stopped).toBe(true);
    await expect(run).resolves.toMatchObject({ status: "cancelled" });
  });

  it("treats malformed structured output as an execution failure", async () => {
    const paths = await fixture();
    const runner: SandcastleAttemptRunner = {
      async run(invocation) {
        return {
          report: { status: "completed", stage: "implementation" },
          runtimeSessionId: "runtime-session-1",
          evidence: [invocation.transcriptPath],
        };
      },
    };
    const adapter = await backend(paths, runner);

    const outcome = await adapter.runAttempt(request(paths), new AbortController().signal);

    expect(outcome).toMatchObject({
      status: "execution-failure",
      error: expect.stringContaining("invalid stage report"),
    });
  });

  it("uses the pull-request contract and read-only explanation prompt for pull-request attempts", async () => {
    const paths = await fixture();
    const invocations: RunnerInvocation[] = [];
    const runner: SandcastleAttemptRunner = {
      async run(invocation) {
        invocations.push(invocation);
        return {
          report: {
            status: "completed",
            title: "Implement requested behavior",
            summary: ["Implements the ticket."],
            eli5: "The service now accepts the requested input and produces the expected result.",
            playByPlay: [{
              explanation: "The entry point applies the requested behavior.",
              references: ["src/service.ts:10"],
            }],
            evidence: ["Inspected the verified diff."],
            unresolvedIssues: [],
          },
          runtimeSessionId: "pull-request-runtime-session",
          evidence: [invocation.transcriptPath],
        };
      },
    };
    const adapter = await backend(paths, runner);

    const outcome = await adapter.runPullRequestAttempt(
      pullRequestRequest(paths),
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({ status: "completed", report: { title: "Implement requested behavior" } });
    expect(invocations[0]?.kind).toBe("pull-request");
    expect(invocations[0]?.prompt).toContain("Stay read-only");
    expect(invocations[0]?.prompt).toContain("verified-tree");
  });

  it("rejects a coding-stage report returned for a pull-request attempt", async () => {
    const paths = await fixture();
    const runner: SandcastleAttemptRunner = {
      async run(invocation) {
        return {
          report,
          runtimeSessionId: "wrong-contract-runtime-session",
          evidence: [invocation.transcriptPath],
        };
      },
    };
    const adapter = await backend(paths, runner);

    const outcome = await adapter.runPullRequestAttempt(
      pullRequestRequest(paths),
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      status: "execution-failure",
      error: expect.stringContaining("invalid pull-request report"),
    });
  });

  it("exports allowlisted evidence through a read-only sandbox path without leaking its host path", async () => {
    const paths = await fixture();
    const evidencePath = join(paths.artifactsPath, "evidence-export", "gate.log");
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, "assertion failed: expected 2, received 1\n");
    const invocations: RunnerInvocation[] = [];
    const adapter = await backend(paths, successfulRunner(invocations));
    const base = request(paths);

    await adapter.runAttempt(request(paths, {
      context: {
        ...base.context,
        evidenceBundles: [{
          schemaVersion: 1,
          runId: "run-1",
          operationId: "implementation-1",
          originatingStage: "implementation",
          provenance: "host-observed",
          checks: [{
            command: "unit",
            outcome: "failed",
            exitCode: 1,
            outputArtifact: { id: "implementation-1-unit.log", path: evidencePath, mediaType: "text/plain" },
            treeId: "current-tree",
          }],
          decisions: ["unit failed"],
          outstandingFindings: [],
          reportReferences: [],
        }],
      },
    }), new AbortController().signal);

    const invocation = invocations[0];
    expect(invocation?.mounts).toContainEqual({
      hostPath: evidencePath,
      sandboxPath: "/home/agent/factory-inputs/evidence/implementation-1-unit.log",
      readonly: true,
    });
    expect(invocation?.prompt).toContain("/home/agent/factory-inputs/evidence/implementation-1-unit.log");
    expect(invocation?.prompt).not.toContain(evidencePath);
    const bundleMount = invocation?.mounts.find(({ sandboxPath }) =>
      sandboxPath === "/home/agent/factory-inputs/evidence-bundles/bundle-001.json"
    );
    expect(bundleMount).toMatchObject({ readonly: true });
    if (bundleMount === undefined) throw new Error("Expected materialized evidence bundle mount");
    const materialized = JSON.parse(await readFile(bundleMount.hostPath, "utf8")) as {
      materializedPath: string;
      checks: { outputArtifact: { path: string } }[];
    };
    expect(materialized).toMatchObject({
      materializedPath: "/home/agent/factory-inputs/evidence-bundles/bundle-001.json",
      checks: [{
        outputArtifact: { path: "/home/agent/factory-inputs/evidence/implementation-1-unit.log" },
      }],
    });
    expect(JSON.stringify(materialized)).not.toContain(evidencePath);
  });

  it("rejects evidence paths outside the host-owned export directory", async () => {
    const paths = await fixture();
    const escapedPath = join(dirname(paths.artifactsPath), "escaped.log");
    await writeFile(escapedPath, "must not be mounted\n");
    const adapter = await backend(paths, successfulRunner([]));
    const base = request(paths);

    const outcome = await adapter.runAttempt(request(paths, {
      context: {
        ...base.context,
        evidenceBundles: [{
          schemaVersion: 1,
          runId: "run-1",
          operationId: "implementation-1",
          originatingStage: "implementation",
          provenance: "host-observed",
          checks: [{
            command: "unit",
            outcome: "failed",
            exitCode: 1,
            outputArtifact: { id: "escaped.log", path: escapedPath, mediaType: "text/plain" },
          }],
          decisions: [],
          outstandingFindings: [],
          reportReferences: [],
        }],
      },
    }), new AbortController().signal);

    expect(outcome).toMatchObject({
      status: "execution-failure",
      error: expect.stringContaining("host-owned artifact export directory"),
    });
  });

  it("mounts every protected input read-only and keeps the transcript outside the workspace", async () => {
    const paths = await fixture();
    const invocations: RunnerInvocation[] = [];
    const adapter = await backend(paths, successfulRunner(invocations));

    await adapter.runAttempt(request(paths), new AbortController().signal);

    const invocation = invocations[0];
    expect(invocation?.mounts).toHaveLength(2);
    expect(invocation?.mounts.every((mount) => mount.readonly === true)).toBe(true);
    expect(invocation?.mounts.map(({ hostPath }) => hostPath)).toEqual([
      paths.standardsPath,
      paths.suitePath,
    ]);
    expect(invocation?.mounts.map(({ sandboxPath }) => sandboxPath)).toEqual([
      "/home/agent/.config/opencode/skills/test-standard",
      "/home/agent/factory-inputs/acceptance",
    ]);
    expect(invocation?.prompt).toContain(
      "/home/agent/.config/opencode/skills/test-standard/SKILL.md",
    );
    expect(invocation?.transcriptPath.startsWith(`${paths.workspacePath}/`)).toBe(false);
  });
});
