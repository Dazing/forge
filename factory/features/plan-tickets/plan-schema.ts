import { z } from "zod";

// Planner selection contract: the planner selects by ID and title only, at most one ticket per iteration.

export const MAX_PARALLEL = 1;

export type PlannedTicket = Readonly<{
  id: string;
  title: string;
}>;

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

/** Validate planner selections against supplied pending tickets; rejects completed, unknown, duplicated, and title-mutated selections. */
export function validatePlan(
  entries: readonly PlannedTicket[],
  available: ReadonlyMap<string, TicketLike>,
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

interface TicketLike {
  readonly id: string;
  readonly title: string;
}
