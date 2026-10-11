import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { CommandFailure } from "../shared/git.js";

// Ticket front-matter parsing, identity, formatting, and plan validation, split from main.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).
const MAX_PARALLEL = 1;

const githubSshUrl = /^git@github\.com:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\.git$/;

const frontMatterSchema = z
  .object({
    name: z.string(),
    repository: z.string().regex(githubSshUrl),
    baseBranch: z.string().min(1).default("main"),
  })
  .strict();

export type Ticket = Readonly<{
  id: string;
  name: string;
  slug: string;
  title: string;
  path: string;
  content: string;
  repository: string;
  githubOwner: string;
  githubRepository: string;
  baseBranch: string;
}>;

export type PlannedTicket = Readonly<{
  id: string;
  title: string;
}>;

/** Typed ticket metadata failure carrying the source path and structured stage details for ticket diagnostics. */
export class TicketMetadataError extends Error {
  constructor(
    readonly path: string,
    readonly failure: CommandFailure,
    cause: unknown,
  ) {
    super(`Ticket metadata is invalid for ${path}: ${failure.operation} — ${failure.stderr}`, { cause });
    this.name = "TicketMetadataError";
  }
}

function metadataFailure(path: string, operation: string, detail: string): CommandFailure {
  return { operation, command: `read ${path}`, exitCode: 1, stdout: "", stderr: detail };
}

/** Parse exactly one ticket file; throws TicketMetadataError with structured stage details for any metadata violation. */
export async function loadTicket(path: string): Promise<Ticket> {
  const ticketPath = resolve(path);
  if (!ticketPath.toLowerCase().endsWith(".md")) {
    throw new TicketMetadataError(ticketPath, metadataFailure(ticketPath, "reading ticket file", "Ticket must be a Markdown file."), undefined);
  }

  let source: string;
  try {
    source = await readFile(ticketPath, "utf8");
  } catch (error) {
    throw new TicketMetadataError(ticketPath, metadataFailure(ticketPath, "reading ticket file", `Could not read ticket: ${ticketPath}`), error);
  }
  if (source.trim().length === 0) {
    throw new TicketMetadataError(ticketPath, metadataFailure(ticketPath, "reading ticket file", "Ticket is empty."), undefined);
  }

  const frontMatterMatch = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontMatterMatch) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(ticketPath, "parsing YAML front matter", "Ticket must start with a --- delimited YAML front matter block."),
      undefined,
    );
  }
  const body = source.slice(frontMatterMatch[0].length);
  const frontMatterText = frontMatterMatch[1] ?? "";

  let frontMatter: unknown;
  try {
    frontMatter = parse(frontMatterText);
  } catch (error) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(ticketPath, "parsing YAML front matter", error instanceof Error ? error.message : String(error)),
      error,
    );
  }

  const validated = frontMatterSchema.safeParse(frontMatter);
  if (!validated.success) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(
        ticketPath,
        "validating ticket front matter",
        validated.error.issues.map((issue) => `${issue.path.join(".") || "<front matter>"} ${issue.message}`).join("; "),
      ),
      undefined,
    );
  }

  const slug = validated.data.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(ticketPath, "normalizing ticket name", `Normalized name is empty; name must contain ASCII letters, digits, or hyphens.`),
      undefined,
    );
  }

  const ssh = githubSshUrl.exec(validated.data.repository);
  if (!ssh) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(ticketPath, "validating repository URL", `Repository must be a git@github.com:<owner>/<repository>.git SSH URL; got ${validated.data.repository}.`),
      undefined,
    );
  }

  return {
    id: createHash("sha256").update(source).digest("hex").slice(0, 16),
    name: validated.data.name,
    slug,
    title: body.match(/^#\s+(.+?)\s*$/m)?.[1] ?? slug,
    path: ticketPath,
    content: body,
    repository: validated.data.repository,
    githubOwner: ssh[1]!,
    githubRepository: ssh[2]!,
    baseBranch: validated.data.baseBranch,
  };
}

/** List Markdown ticket files in a directory as sorted full paths; non-Markdown entries are ignored. */
export async function listTicketPaths(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .map((name) => resolve(dir, name))
    .sort();
}

/** Render tickets as tagged prompt blocks with stable IDs, titles, repository context, and body content. */
export function formatTickets(tickets: readonly Ticket[]): string {
  return tickets
    .map(
      (ticket) =>
        `<ticket id="${ticket.id}" name=${JSON.stringify(ticket.name)} title=${JSON.stringify(ticket.title)} repository="${ticket.repository}" base-branch="${ticket.baseBranch}">\n` +
        `<host-path>${ticket.path}</host-path>\n` +
        `<content>\n${ticket.content}\n</content>\n` +
        `</ticket>`,
    )
    .join("\n\n");
}

export const planSchema = z
  .object({
    tickets: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string(),
          })
          .strict(),
      )
      .max(MAX_PARALLEL),
  })
  .strict();

/** Validate planner selections against supplied pending tickets; rejects completed, unknown, duplicated, and title-mutated tickets. */
export function validatePlan(
  entries: readonly PlannedTicket[],
  available: ReadonlyMap<string, Ticket>,
  completed: ReadonlySet<string>,
): PlannedTicket[] {
  const selected = new Set<string>();
  return entries.map((candidate) => {
    if (completed.has(candidate.id)) {
      throw new Error(`Planner selected already completed ticket ${candidate.id}.`);
    }
    const ticket = available.get(candidate.id);
    if (!ticket) {
      throw new Error(`Planner selected unknown ticket ${candidate.id}; only supplied pending tickets are allowed.`);
    }
    if (selected.has(candidate.id)) {
      throw new Error(`Planner selected ticket ${candidate.id} more than once.`);
    }
    selected.add(candidate.id);
    if (candidate.title !== ticket.title) {
      throw new Error(`Planner changed title for ticket ${candidate.id}.`);
    }
    return { id: ticket.id, title: ticket.title };
  });
}
