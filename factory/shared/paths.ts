import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";

// Path existence and directory checks shared by the runner, its sandbox preflight, and the proof harness.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

/** Stat a required host path, naming the label and path when it is missing. */
export async function requirePath(path: string, label: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}`, { cause: error });
  }
}

/** Require an existing directory, naming the label and path when it is missing or not a directory. */
export async function requireDirectory(path: string, label: string): Promise<void> {
  const details = await requirePath(path, label);
  if (!details.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}
