import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { InvocationLogger } from "./invocation-log.js";

test("main.log records redact the provider credential from recorded output", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-log-"));
  const logger = await InvocationLogger.create(root, "vso_pat_secret_123");

  await logger.record({
    timestamp: "2026-10-11T09:00:00.000Z",
    ticketId: "0123456789abcdef",
    attemptId: "1a2b3c",
    stage: "draft pull request",
    operation: "creating draft pull request",
    status: "failed",
    stdout: "TF400813: Authorization failed for vso_pat_secret_123",
    stderr: "HTTP 401 Unauthorized",
  });

  const log = await readFile(join(logger.runDir, "main.log"), "utf8");
  assert.match(log, /2026-10-11T09:00:00\.000Z ticket=0123456789abcdef attempt=1a2b3c stage=draft pull request operation=creating draft pull request status=failed/);
  assert.match(log, /stdout:\nTF400813: Authorization failed for \[redacted-token\]/);
  assert.ok(!log.includes("vso_pat_secret_123"), "the literal credential never reaches main.log");
});

test("records without command output omit the output sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-log-"));
  const logger = await InvocationLogger.create(root, "gh_secret_abc");

  await logger.record({ timestamp: "2026-10-11T09:00:00.000Z", stage: "planner", operation: "running planner", status: "completed" });

  const log = await readFile(join(logger.runDir, "main.log"), "utf8");
  assert.equal(log.trim(), "2026-10-11T09:00:00.000Z stage=planner operation=running planner status=completed");
});

test("checkpoint records serialize parent, checkpoint, changes, and agent log after the status", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-log-"));
  const logger = await InvocationLogger.create(root, "gh_secret_abc");

  await logger.record({
    timestamp: "2026-10-11T09:05:00.000Z",
    ticketId: "0123456789abcdef",
    attemptId: "1a2b3c",
    stage: "implementation commit",
    operation: "creating stage checkpoint commit",
    status: "completed",
    parentSha: "1".repeat(40),
    checkpointSha: "2".repeat(40),
    changes: "changed",
    agentLogBasename: "implement-0123456789abcdef-1a2b3c.log",
  });

  const log = await readFile(join(logger.runDir, "main.log"), "utf8");
  const parent = "1".repeat(40);
  const checkpoint = "2".repeat(40);
  assert.match(log, new RegExp(`stage=implementation commit operation=creating stage checkpoint commit status=completed parent=${parent} checkpoint=${checkpoint} changes=changed agent-log=implement-0123456789abcdef-1a2b3c\\.log`));
});

test("the agent log basename is the stage log filename recorded in checkpoint trailers", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-log-"));
  const logger = await InvocationLogger.create(root, "gh_secret_abc");

  assert.equal(logger.agentLogBasename("implement-0123456789abcdef-1a2b3c"), "implement-0123456789abcdef-1a2b3c.log");
  assert.equal(basename(logger.agentLogPath("implement-0123456789abcdef-1a2b3c")), "implement-0123456789abcdef-1a2b3c.log");
});
