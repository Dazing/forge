import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { InvocationLogger, type LogTarget } from "./invocation-log.js";

const INSTANCE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{6}$/;

test("the invocation directory is a sortable UTC stamp with a random suffix and holds main.log at its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-log-"));
  const logger = await InvocationLogger.create(root, "gh_secret_abc");

  await logger.record({ timestamp: "2026-10-11T09:00:00.000Z", stage: "planner", operation: "running planner", status: "completed" });

  assert.match(basename(logger.runDir), INSTANCE, "the instance directory is a second-resolution UTC stamp plus a six-hex suffix");
  assert.match(basename(logger.runDir).split("-").pop()!, /^[0-9a-f]{6}$/, "the suffix is identity, not a process ID");
  assert.equal((await readdir(join(root, ".logs"))).length, 1);
  const log = await readFile(join(logger.runDir, "main.log"), "utf8");
  assert.equal(log.trim(), "2026-10-11T09:00:00.000Z stage=planner operation=running planner status=completed");
});

test("simultaneous invocations never select the same instance directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-log-"));
  const [left, right] = await Promise.all([InvocationLogger.create(root, "gh_secret_abc"), InvocationLogger.create(root, "gh_secret_abc")]);

  assert.notEqual(left.runDir, right.runDir);
  assert.equal((await readdir(join(root, ".logs"))).length, 2);
});

test("planner cycles allocate zero-padded ordered files under planner/ and never share a file with stages", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-log-"));
  const logger = await InvocationLogger.create(root, "gh_secret_abc");

  const first = await logger.allocate({ scope: "sequence", directory: "planner", cycle: 1 });
  const second = await logger.allocate({ scope: "sequence", directory: "planner", cycle: 2 });
  const stage = await logger.allocate({ scope: "attempt", attemptId: "1a2b3c", stage: "implement" });

  assert.equal(first.reference, "planner/001.log");
  assert.equal(second.reference, "planner/002.log");
  assert.equal(first.path, join(logger.runDir, "planner", "001.log"));
  assert.notEqual(dirname(stage.reference), "planner");

  await writeFile(first.path, "cycle 1\n");
  await writeFile(second.path, "cycle 2\n");
  assert.deepEqual((await readdir(join(logger.runDir, "planner"))).sort(), ["001.log", "002.log"]);
});

test("one attempt ID binds one timestamped directory and every later run reuses it", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-log-"));
  const logger = await InvocationLogger.create(root, "gh_secret_abc");

  const implement = await logger.allocate({ scope: "attempt", attemptId: "1a2b3c", stage: "implement" });
  const retry = await logger.allocate({ scope: "attempt", attemptId: "1a2b3c", stage: "implement" });
  const review = await logger.allocate({ scope: "attempt", attemptId: "1a2b3c", stage: "review" });
  const other = await logger.allocate({ scope: "attempt", attemptId: "ffee00", stage: "implement" });

  assert.match(implement.reference, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-1a2b3c\/implement-1\.log$/);
  assert.equal(retry.reference, `${dirname(implement.reference)}/implement-2.log`);
  assert.equal(review.reference, `${dirname(implement.reference)}/review-1.log`);
  assert.notEqual(dirname(other.reference), dirname(implement.reference), "distinct attempt IDs cannot share a directory");
});

test("concurrent allocations for one attempt and stage produce unique files in one directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-log-"));
  const logger = await InvocationLogger.create(root, "gh_secret_abc");

  const allocations = await Promise.all(
    Array.from({ length: 5 }, () => logger.allocate({ scope: "attempt", attemptId: "1a2b3c", stage: "integrate" })),
  );
  for (const allocation of allocations) await writeFile(allocation.path, `${allocation.reference}\n`);

  assert.equal(new Set(allocations.map((allocation) => allocation.reference)).size, 5);
  assert.equal(new Set(allocations.map((allocation) => dirname(allocation.reference))).size, 1);
  assert.deepEqual(
    (await readdir(join(logger.runDir, dirname(allocations[0]!.reference)))).sort(),
    ["integrate-1.log", "integrate-2.log", "integrate-3.log", "integrate-4.log", "integrate-5.log"],
  );
});

test("unsafe log targets fail before any directory is created outside the instance root", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-log-"));
  const logger = await InvocationLogger.create(root, "gh_secret_abc");
  await logger.record({ timestamp: "2026-10-11T09:00:00.000Z", stage: "planner", operation: "running planner", status: "completed" });

  const targets: LogTarget[] = [
    { scope: "attempt", attemptId: "../escape", stage: "implement" },
    { scope: "attempt", attemptId: "a/b", stage: "implement" },
    { scope: "attempt", attemptId: "a\\b", stage: "implement" },
    { scope: "attempt", attemptId: "", stage: "implement" },
    { scope: "attempt", attemptId: "1a2b3c", stage: "../implement" },
    { scope: "attempt", attemptId: "1a2b3c", stage: "a/b" },
    { scope: "attempt", attemptId: "1a2b3c", stage: "" },
    { scope: "sequence", directory: "/etc", cycle: 1 },
    { scope: "sequence", directory: "..", cycle: 1 },
    { scope: "sequence", directory: "", cycle: 1 },
    { scope: "sequence", directory: "planner", cycle: 0 },
    { scope: "sequence", directory: "planner", cycle: 1.5 },
  ];
  for (const target of targets) {
    await assert.rejects(logger.allocate(target), /log /, `${JSON.stringify(target)} must be rejected`);
  }

  assert.deepEqual(await readdir(logger.runDir), ["main.log"]);
  assert.deepEqual(await readdir(join(root, ".logs")), [basename(logger.runDir)]);
});

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

test("checkpoint records serialize parent, checkpoint, changes, and the run-relative transcript reference after the status", async () => {
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
    agentLogReference: "2026-10-11_09-04-58-1a2b3c/implement-2.log",
  });

  const log = await readFile(join(logger.runDir, "main.log"), "utf8");
  const parent = "1".repeat(40);
  const checkpoint = "2".repeat(40);
  assert.match(log, new RegExp(`stage=implementation commit operation=creating stage checkpoint commit status=completed parent=${parent} checkpoint=${checkpoint} changes=changed agent-log=2026-10-11_09-04-58-1a2b3c/implement-2\\.log`));
});
