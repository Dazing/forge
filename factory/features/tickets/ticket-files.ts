import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

/** List Markdown ticket files in a directory as sorted full paths; non-Markdown entries are ignored. */
export async function listTicketPaths(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .map((name) => resolve(dir, name))
    .sort();
}
/** List active and lifecycle Markdown tickets used only for startup reconciliation diagnostics. */
export async function listRelevantTicketPaths(dir: string): Promise<string[]> {
  const paths = await listTicketPaths(dir);
  for (const lifecycleDir of ["done", "failed"]) {
    const nested = await readdir(resolve(dir, lifecycleDir)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    paths.push(...nested.filter((name) => name.toLowerCase().endsWith(".md")).map((name) => resolve(dir, lifecycleDir, name)));
  }
  return paths.sort();
}
