import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";

// Ticket loading, formatting, and plan validation, split from main.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).
const MAX_PARALLEL = 1;

export type Ticket = Readonly<{
  id: string;
  title: string;
  path: string;
  content: string;
  branch: string;
}>;

export type PlannedTicket = Readonly<{
  id: string;
  title: string;
  branch: string;
}>;

function ticketTitle(path: string, content: string): string {
  const heading = content.match(/^#\s+(.+?)\s*$/m)?.[1];
  return heading ?? basename(path, ".md");
}

/** Load host Markdown tickets, rejecting duplicate paths, non-Markdown, empty files, and duplicate content (stable ticket IDs are content hashes). */
export async function loadTickets(paths: readonly string[]): Promise<Ticket[]> {
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  const tickets: Ticket[] = [];

  for (const suppliedPath of paths) {
    const path = resolve(suppliedPath);
    if (seenPaths.has(path)) {
      throw new Error(`Ticket path was supplied more than once: ${path}`);
    }
    seenPaths.add(path);
    if (!path.toLowerCase().endsWith(".md")) {
      throw new Error(`Ticket must be a Markdown file: ${path}`);
    }

    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      throw new Error(`Could not read ticket: ${path}`, { cause: error });
    }
    if (content.trim().length === 0) {
      throw new Error(`Ticket is empty: ${path}`);
    }

    const id = createHash("sha256").update(content).digest("hex").slice(0, 16);
    if (seenIds.has(id)) {
      throw new Error(`Tickets must have distinct content; stable ticket ID ${id} is duplicated.`);
    }
    seenIds.add(id);
    tickets.push({
      id,
      title: ticketTitle(path, content),
      path,
      content,
      branch: `sandcastle/ticket-${id}`,
    });
  }

  return tickets;
}

/** Render tickets as tagged prompt blocks with stable IDs, titles, branches, and full content. */
export function formatTickets(tickets: readonly Ticket[]): string {
  return tickets
    .map(
      (ticket) =>
        `<ticket id="${ticket.id}" title=${JSON.stringify(ticket.title)} branch="${ticket.branch}">\n` +
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
            branch: z.string(),
          })
          .strict(),
      )
      .max(MAX_PARALLEL),
  })
  .strict();

/** Validate planner selections against supplied pending tickets; rejects completed, unknown, duplicated, and title- or branch-mutated tickets. */
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
    if (candidate.branch !== ticket.branch) {
      throw new Error(`Planner branch for ${candidate.id} must be ${ticket.branch}.`);
    }
    return { id: ticket.id, title: ticket.title, branch: ticket.branch };
  });
}
