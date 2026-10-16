import { open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseSubmissionRecord, submissionStatePath, type SubmissionRecord } from "./submission-schema.js";

// Durable local half of submission: the per-ticket sidecar, written atomically after each accepted
// ticket so a crash mid-batch leaves completed entries recorded, and the batch lock that gives one
// submission root a single writer (plan §3 D3).

/** Lock file name owned by one submission root. */
export const SUBMISSION_LOCK_FILE = ".sandcastle-submission.lock";

/** Another submission owns the root; the reported path and PID are the operator's whole diagnosis. */
export class SubmissionLockError extends Error {
  constructor(
    readonly lockPath: string,
    readonly pid: number | undefined,
  ) {
    super(`Another ticket submission holds ${lockPath}${pid === undefined ? "" : ` (PID ${pid})`}; it is not removed automatically.`);
    this.name = "SubmissionLockError";
  }
}

/** The directory that owns the batch lock: the common parent of every input path. */
export function submissionRoot(paths: readonly string[], cwd: string): string {
  if (paths.length === 0) return resolve(cwd);
  const directories = paths.map((path) => dirname(resolve(cwd, path)));
  let common = directories[0] ?? resolve(cwd);
  for (const directory of directories) {
    let candidate = common;
    while (candidate.length > 1 && !directory.startsWith(candidate)) {
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    common = candidate;
  }
  return common;
}

/** Read the PID recorded in an existing lock, when the file is readable. */
async function lockHolder(lockPath: string): Promise<number | undefined> {
  const text = await readFileSafe(lockPath);
  if (text === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(text);
    if (typeof decoded !== "object" || decoded === null || !("pid" in decoded)) return undefined;
    const pid = decoded.pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function readFileSafe(path: string): Promise<string | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

/**
 * Claim the batch lock with the `wx` flag. An existing lock — live or stale — is reported with its
 * path and PID and is never removed, so two submissions never touch the backlog together.
 */
export async function acquireSubmissionLock(root: string, pid: number, startedAt: string): Promise<string> {
  const lockPath = join(root, SUBMISSION_LOCK_FILE);
  const handle = await open(lockPath, "wx").catch(async (error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined;
    throw error;
  });
  if (handle === undefined) {
    throw new SubmissionLockError(lockPath, await lockHolder(lockPath));
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid, startedAt }, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return lockPath;
}

/** Release the batch lock; called on success and on failure. */
export async function releaseSubmissionLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

/** Write one sidecar atomically: a same-directory temp file, then a rename onto the final name. */
export async function writeSubmissionRecord(sidecarPath: string, record: SubmissionRecord): Promise<void> {
  const tempPath = `${sidecarPath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tempPath, sidecarPath);
}

/** Read the sidecar beside one source; absence means a new submission, a broken file is a per-ticket failure. */
export async function readSubmissionRecord(sourcePath: string): Promise<SubmissionRecord | undefined> {
  const sidecarPath = submissionStatePath(sourcePath);
  const text = await readFileSafe(sidecarPath);
  if (text === undefined) return undefined;
  return parseSubmissionRecord(sidecarPath, text);
}
