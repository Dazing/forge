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
