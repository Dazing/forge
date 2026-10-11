import { createHash } from "node:crypto";
import type { Ticket } from "../tickets/index.js";

export type DeliveryGroup = Readonly<{
  id: string;
  repository: string;
  baseBranch: string;
  memberIds: readonly string[];
}>;

export type DependencyGraph = Readonly<{
  tickets: ReadonlyMap<string, Ticket>;
  groups: readonly DeliveryGroup[];
  missingDependencies: ReadonlyMap<string, readonly string[]>;
  readyTicketIds(completed: ReadonlySet<string>, excluded?: ReadonlySet<string>): string[];
}>;

export function buildDependencyGraph(tickets: readonly Ticket[]): DependencyGraph {
  const byId = new Map<string, Ticket>();
  for (const ticket of tickets) {
    if (byId.has(ticket.id)) throw new Error(`Duplicate ticket ID ${ticket.id}.`);
    byId.set(ticket.id, ticket);
  }

  const missingDependencies = new Map<string, readonly string[]>();
  const dependents = new Map<string, string[]>();
  for (const ticket of tickets) {
    const missing = ticket.dependsOnTickets.filter((dependencyId) => !byId.has(dependencyId));
    if (missing.length > 0) missingDependencies.set(ticket.id, missing);
    for (const dependencyId of ticket.dependsOnTickets) {
      const dependency = byId.get(dependencyId);
      if (dependency === undefined) continue;
      if (dependency.repository !== ticket.repository || dependency.baseBranch !== ticket.baseBranch) {
        throw new Error(`Ticket ${ticket.id} dependency ${dependencyId} has an incompatible repository/base branch edge.`);
      }
      const children = dependents.get(dependencyId) ?? [];
      children.push(ticket.id);
      dependents.set(dependencyId, children);
    }
  }

  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (ticketId: string): void => {
    const cycleAt = visiting.indexOf(ticketId);
    if (cycleAt >= 0) throw new Error(`Ticket dependency cycle: ${[...visiting.slice(cycleAt), ticketId].join(" -> ")}.`);
    if (visited.has(ticketId)) return;
    visiting.push(ticketId);
    for (const dependencyId of byId.get(ticketId)?.dependsOnTickets ?? []) {
      if (byId.has(dependencyId)) visit(dependencyId);
    }
    visiting.pop();
    visited.add(ticketId);
  };
  for (const ticketId of [...byId.keys()].sort()) visit(ticketId);

  const assigned = new Set<string>();
  const groups: DeliveryGroup[] = [];
  for (const startId of [...byId.keys()].sort()) {
    if (assigned.has(startId)) continue;
    const members: string[] = [];
    const queue = [startId];
    assigned.add(startId);
    while (queue.length > 0) {
      const ticketId = queue.shift()!;
      members.push(ticketId);
      const ticket = byId.get(ticketId)!;
      const neighbors = [...ticket.dependsOnTickets.filter((id) => byId.has(id)), ...(dependents.get(ticketId) ?? [])].sort();
      for (const neighbor of neighbors) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        queue.push(neighbor);
      }
    }
    members.sort();
    const first = byId.get(members[0]!)!;
    groups.push({
      id: createHash("sha256").update(`${first.repository}\0${first.baseBranch}\0${members.join("\0")}`).digest("hex").slice(0, 16),
      repository: first.repository,
      baseBranch: first.baseBranch,
      memberIds: members,
    });
  }

  return {
    tickets: byId,
    groups,
    missingDependencies,
    readyTicketIds(completed, excluded = new Set()) {
      return [...byId.values()]
        .filter((ticket) => !completed.has(ticket.id)
          && !excluded.has(ticket.id)
          && !missingDependencies.has(ticket.id)
          && ticket.dependsOnTickets.every((dependencyId) => completed.has(dependencyId)))
        .map((ticket) => ticket.id)
        .sort();
    },
  };
}
