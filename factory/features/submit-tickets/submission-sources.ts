import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitProvider, GitProviderRegistry } from "../../infrastructure/git-provider/git-provider.js";
import { listTicketPaths, parseTicketSource, type Ticket } from "../tickets/index.js";

// Input expansion and batch validation for `npm run tickets -- submit` (plan §3 D3): every gate that
// can be answered without a remote write is answered for the whole batch before the first write, so
// one invalid ticket stops the batch with zero effects.

/** One expanded input file with the exact source bytes read from it. */
export type SourceFile = Readonly<{ path: string; source: string }>;

/** One parsed ticket plus the exact source and local path it came from. */
export type ValidatedSource = Readonly<{ path: string; source: string; ticket: Ticket }>;

/** A validation rejection naming the source it came from. */
export type SourceProblem = Readonly<{ path: string | undefined; reason: string }>;

/** The result of the pre-write validation phase; `sources` is only populated when `problems` is empty. */
export type BatchValidation = Readonly<{
  sources: readonly ValidatedSource[];
  problems: readonly SourceProblem[];
}>;
const GLOB_MAGIC = /[[\]{}*?]/;
const SKIPPED_DIRECTORIES: Record<string, true> = { ".git": true, ".sandcastle": true, ".logs": true, ".workspaces": true, ".ticket-queue": true, ".factory-state": true, node_modules: true };

function globToRegExp(pattern: string): RegExp {
  let body = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      const recursive = pattern[index + 1] === "*";
      if (recursive) {
        const skipsSeparator = pattern[index + 2] === "/";
        body += skipsSeparator ? "(?:.*/)??" : ".*";
        index += skipsSeparator ? 2 : 1;
      } else {
        body += "[^/]*";
      }
    } else if (character === "?") {
      body += "[^/]";
    } else {
      body += character.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${body}$`);
}

/** Every Markdown file under `directory`, sorted by path, skipping repository bookkeeping directories. */
async function walkMarkdown(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES[entry.name] === true) continue;
      found.push(...await walkMarkdown(join(directory, entry.name)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      found.push(join(directory, entry.name));
    }
  }
  return found.sort();
}

/** Longest magic-free directory prefix of a pattern; the filesystem walk starts there. */
function staticPrefix(pattern: string): string {
  const segments = pattern.split("/");
  const statics: string[] = [];
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) break;
    statics.push(segment);
  }
  return statics.join("/");
}

/** Expand one CLI path: a file, a directory's top-level Markdown tickets, or a glob over the filesystem. */
async function expandPath(pattern: string, cwd: string): Promise<string[]> {
  const rooted = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
  if (!GLOB_MAGIC.test(pattern)) {
    const details = await stat(rooted).catch(() => undefined);
    if (details === undefined) throw new Error(`Ticket path does not exist: ${pattern}`);
    if (details.isDirectory()) return listTicketPaths(rooted);
    return [rooted];
  }

  const prefix = staticPrefix(rooted);
  const root = prefix.length === 0 ? cwd : prefix;
  const rootDetails = await stat(root).catch(() => undefined);
  if (rootDetails === undefined) throw new Error(`Ticket pattern ${pattern} matches no file: ${root} does not exist.`);
  const matches = globToRegExp(rooted);
  const candidates = rootDetails.isDirectory() ? await walkMarkdown(root) : [root];
  const relativePattern = globToRegExp(relative(cwd, rooted).split(sep).join("/"));
  const expanded = candidates
    .filter((candidate) => relativePattern.test(relative(cwd, candidate).split(sep).join("/")) || matches.test(candidate))
    .sort();
  if (expanded.length === 0) throw new Error(`Ticket pattern ${pattern} matches no Markdown ticket.`);
  return expanded;
}

/** Expand every CLI path into a de-duplicated, deterministic list of ticket sources. */
export async function expandTicketPaths(patterns: readonly string[], cwd: string): Promise<string[]> {
  const expanded: string[] = [];
  for (const pattern of patterns) {
    expanded.push(...await expandPath(pattern, cwd));
  }
  return [...new Set(expanded)].sort();
}

/** Read every expanded path; an unreadable file is reported as a problem for that path. */
export async function readTicketSources(paths: readonly string[]): Promise<Readonly<{ files: SourceFile[]; problems: SourceProblem[] }>> {
  const files: SourceFile[] = [];
  const problems: SourceProblem[] = [];
  for (const path of paths) {
    const source = await readFile(path, "utf8").catch(() => undefined);
    if (source === undefined) {
      problems.push({ path, reason: `Ticket source could not be read: ${path}` });
      continue;
    }
    files.push({ path, source });
  }
  return { files, problems };
}

/** Build the per-repository registry the ticket parser needs from the single client provider. */
export function submissionProviderRegistry(provider: GitProvider): GitProviderRegistry {
  return {
    names: [provider.name],
    secrets: provider.secrets(),
    resolve: (repositoryUrl: string) => {
      provider.validateRepository(repositoryUrl);
      return provider;
    },
  };
}

/** Canonicalise the `owner/repository` form accepted by `--repository` into the SSH URL a provider validates; anything URL-shaped passes through. */
export function canonicalRepositoryUrl(repository: string): string {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository) ? `git@github.com:${repository}.git` : repository;
}

/**
 * Validate the whole batch before any write: parse each source, reject duplicate ticket IDs, reject a
 * repository the provider rejects, reject a dependency that exists neither in the batch nor in the
 * backlog, and reject dependency cycles.
 */
export function validateBatch(input: Readonly<{
  files: readonly SourceFile[];
  providers: GitProviderRegistry;
  provider: GitProvider;
  repositoryOverride?: string;
  knownTicketIds: ReadonlyMap<string, number>;
}>): BatchValidation {
  const problems: SourceProblem[] = [];
  const sources: ValidatedSource[] = [];
  const byTicketId = new Map<string, string>();

  for (const file of input.files) {
    let ticket: Ticket;
    try {
      ticket = parseTicketSource(file.source, input.providers, file.path);
    } catch (error) {
      problems.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const declared = byTicketId.get(ticket.id);
    if (declared !== undefined) {
      problems.push({ path: file.path, reason: `Ticket ID ${ticket.id} is declared by ${declared} and ${file.path}; ticket IDs are unique per backlog repository.` });
      continue;
    }
    byTicketId.set(ticket.id, file.path);

    const target = input.repositoryOverride ?? ticket.repository;
    try {
      input.provider.validateRepository(canonicalRepositoryUrl(target));
    } catch (error) {
      problems.push({ path: file.path, reason: `Repository ${target} is not usable with the ${input.provider.name} provider: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    sources.push({ path: file.path, source: file.source, ticket });
  }

  for (const source of sources) {
    for (const dependency of source.ticket.dependsOnTickets) {
      if (dependency === source.ticket.id) {
        problems.push({ path: source.path, reason: `Ticket ${source.ticket.id} declares itself as a dependency.` });
        continue;
      }
      if (!byTicketId.has(dependency) && !input.knownTicketIds.has(dependency)) {
        problems.push({ path: source.path, reason: `Ticket ${source.ticket.id} depends on ${dependency}, which is in neither this batch nor the backlog.` });
      }
    }
  }

  const cycle = findDependencyCycle(sources.map((source) => ({ id: source.ticket.id, dependsOn: source.ticket.dependsOnTickets })));
  if (cycle !== undefined) {
    problems.push({
      path: sources.find((source) => source.ticket.id === cycle[0])?.path,
      reason: `Dependency cycle: ${cycle.join(" -> ")}`,
    });
  }

  return { sources: problems.length === 0 ? sources : [], problems };
}

/**
 * Find one dependency cycle among the batch's declared edges (backlog-resolved dependencies are not
 * edges). `tickets` is the identity leaf and exports no graph walk, and the coordinator's cycle check
 * belongs to `ticket-processing`, which submission must never import.
 */
export function findDependencyCycle(tickets: ReadonlyArray<Readonly<{ id: string; dependsOn: readonly string[] }>>): string[] | undefined {
  const edges = new Map(tickets.map((ticket) => [ticket.id, ticket.dependsOn.filter((dependency) => dependency !== ticket.id)]));
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  function walk(id: string): string[] | undefined {
    if (onStack.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return undefined;
    visited.add(id);
    onStack.add(id);
    stack.push(id);
    for (const dependency of edges.get(id) ?? []) {
      if (!edges.has(dependency)) continue;
      const cycle = walk(dependency);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    onStack.delete(id);
    return undefined;
  }

  for (const ticket of tickets) {
    const cycle = walk(ticket.id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}
