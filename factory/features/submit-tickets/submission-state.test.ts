import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SubmissionRecord } from "./submission-schema.js";
import { SUBMISSION_LOCK_FILE, SubmissionLockError, acquireSubmissionLock, readSubmissionRecord, releaseSubmissionLock, submissionRoot, writeSubmissionRecord } from "./submission-state.js";

// Local durability: the sidecar is written atomically and the batch lock is claimed exclusively, so
// an interrupted run replays from what it recorded and two runs never share the backlog.

const RECORD: SubmissionRecord = {
  version: 1,
  backlogRepository: "acme/backlog",
  projectId: "PVT_project_1",
  issueNumber: 12,
  issueNodeId: "ISSIONODE_12",
  issueUrl: "https://github.com/acme/backlog/issues/12",
  sourceHash: "a".repeat(64),
  requirementsHash: "b".repeat(64),
  submittedAt: "2026-10-16T10:00:00.000Z",
  lastComment: {
    id: 42,
    url: "https://github.com/acme/backlog/issues/12#issuecomment-42",
    marker: "<!-- factory:comment:T-1:abcdef012345 -->",
    sourceHash: "c".repeat(64),
    postedAt: "2026-10-16T10:00:01.000Z",
  },
};

async function scratch(names: readonly string[] = []): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "submission-state-"));
  for (const name of names) {
    const path = join(directory, name);
    if (name.includes("/")) {
      await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    }
    await writeFile(path, "ticket", "utf8");
  }
  return directory;
}

test("a sidecar is written atomically and leaves no temp file behind", async () => {
  const directory = await scratch(["first.md"]);
  const sidecarPath = join(directory, "first.submission.json");

  await writeSubmissionRecord(sidecarPath, RECORD);
  await writeSubmissionRecord(sidecarPath, { ...RECORD, issueNumber: 13 });

  assert.deepEqual(JSON.parse(await readFile(sidecarPath, "utf8")), { ...RECORD, issueNumber: 13 });
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), [], "the rename consumes the temp file");
  assert.equal((await readSubmissionRecord(join(directory, "first.md")))?.issueNumber, 13);
});

test("a missing sidecar reads as undefined and a broken one throws naming the path", async () => {
  const directory = await scratch(["first.md", "broken.submission.json"]);
  await writeFile(join(directory, "broken.submission.json"), "{", "utf8");

  assert.equal(await readSubmissionRecord(join(directory, "absent.md")), undefined);
  await assert.rejects(
    () => readSubmissionRecord(join(directory, "broken.md")),
    (error: unknown) => error instanceof Error && /broken\.submission\.json/.test(error.message),
  );
});

test("the batch lock is exclusive and reports the holder", async () => {
  const directory = await scratch();

  const lockPath = await acquireSubmissionLock(directory, 4242, "2026-10-16T10:00:00.000Z");

  assert.equal(lockPath, join(directory, SUBMISSION_LOCK_FILE));
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), { pid: 4242, startedAt: "2026-10-16T10:00:00.000Z" });

  const error = await acquireSubmissionLock(directory, 99, "2026-10-16T10:01:00.000Z").then(
    () => undefined,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof SubmissionLockError);
  assert.match(error.message, /sandcastle-submission\.lock/);
  assert.match(error.message, /4242/);

  await releaseSubmissionLock(lockPath);
  await acquireSubmissionLock(directory, 99, "2026-10-16T10:02:00.000Z");
});

test("the lock lives in the common parent of every input path", async () => {
  const directory = await scratch(["a.md", "nested/b.md"]);

  assert.equal(submissionRoot([join(directory, "a.md")], directory), directory);
  assert.equal(submissionRoot([join(directory, "a.md"), join(directory, "nested", "b.md")], directory), directory);
  assert.equal(submissionRoot([join(directory, "nested", "b.md")], directory), join(directory, "nested"));
});
