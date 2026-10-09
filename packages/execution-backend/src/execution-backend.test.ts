import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttemptRequest, StageReport } from "@factory/core";
import {
  ExecutionBackend,
  type RunnerInvocation,
  type SandcastleAttemptRunner,
} from "./execution-backend.js";

const report: StageReport = {
  status: "completed",
  stage: "implementation",
  criteria: [{ id: "criterion-1", verdict: "met", evidence: ["tests passed"] }],
  evidence: ["tests passed"],
  changedWork: "Implemented the requested behavior.",
  unresolvedIssues: [],
};

interface FixturePaths {
  readonly workspacePath: string;
  readonly artifactsPath: string;
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
  const standardsPath = join(root, "protected", "standards.md");
  const suitePath = join(root, "protected", "acceptance");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(suitePath, { recursive: true });
  await writeFile(standardsPath, "standards");
  return { workspacePath, artifactsPath, standardsPath, suitePath };
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
    attempt,
    baseCommit: "original-base-commit",
    snapshotId: "current-tree",
    standards: [paths.standardsPath],
    acceptanceSuite: {
      version: "1",
      digest: "suite-digest",
      path: paths.suitePath,
    },
    priorReports: [],
    failureEvidence: [],
  };

  return {
    runId: "run-1",
    stage,
    attempt,
    attemptId: "implementation-1",
    sessionId: "session-1",
    workspacePath: paths.workspacePath,
    deadline: Date.now() + 10_000,
    correction: false,
    context,
    ...overrides,
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
      endpoint: "http://vllm.internal:8000/v1",
      modelId: "test-model",
      artifactsPath: paths.artifactsPath,
    },
    runner,
  );
}

describe("ExecutionBackend", () => {
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
      "/home/agent/factory-inputs/standards/1",
      "/home/agent/factory-inputs/acceptance",
    ]);
    expect(invocation?.transcriptPath.startsWith(`${paths.workspacePath}/`)).toBe(false);
  });
});
