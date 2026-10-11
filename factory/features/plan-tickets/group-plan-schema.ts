import { z } from "zod";

export type PlannedGroup = Readonly<{
  groupId: string;
  tickets: readonly Readonly<{ id: string; title: string }>[];
}>;

export const groupPlanSchema = z.object({
  groups: z.array(z.object({
    groupId: z.string().trim().min(1),
    tickets: z.array(z.object({ id: z.string().trim().min(1), title: z.string() }).strict()).min(1),
  }).strict()).max(1),
}).strict();

export function validateGroupPlan(entries: readonly PlannedGroup[], available: ReadonlyMap<string, PlannedGroup>): PlannedGroup[] {
  const selected = new Set<string>();
  return entries.map((entry) => {
    if (selected.has(entry.groupId)) throw new Error(`Planner selected delivery group ${entry.groupId} more than once.`);
    selected.add(entry.groupId);
    const expected = available.get(entry.groupId);
    if (expected === undefined) throw new Error(`Planner selected unknown delivery group ${entry.groupId}.`);
    if (entry.tickets.length !== expected.tickets.length || entry.tickets.some((ticket, index) => ticket.id !== expected.tickets[index]?.id || ticket.title !== expected.tickets[index]?.title)) {
      throw new Error(`Planner changed membership or titles for delivery group ${entry.groupId}.`);
    }
    return expected;
  });
}
