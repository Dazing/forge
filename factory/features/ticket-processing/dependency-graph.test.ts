import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ticket } from "../tickets/index.js";
import { buildDependencyGraph } from "./dependency-graph.js";

function ticket(id: string, dependsOnTickets: readonly string[] = [], repository = "git@github.com:acme/app.git", baseBranch = "main"): Ticket {
  return { id, sourceHash: `${id}-source`, requirementsHash: `${id}-requirements`, dependsOnTickets, name: id, slug: id, title: id, path: `/tickets/${id}.md`, content: `# ${id}`, repository, baseBranch };
}

test("dependency graph forms connected groups and exposes only satisfied ready tickets", () => {
  const graph = buildDependencyGraph([ticket("a"), ticket("b", ["a"]), ticket("c", ["a"]), ticket("d", ["b", "c"]), ticket("x")]);
  assert.deepEqual(graph.groups.map((group) => group.memberIds), [["a", "b", "c", "d"], ["x"]]);
  assert.deepEqual(graph.readyTicketIds(new Set()), ["a", "x"]);
  assert.deepEqual(graph.readyTicketIds(new Set(["a"])), ["b", "c", "x"]);
  assert.deepEqual(graph.readyTicketIds(new Set(["a", "b"])), ["c", "x"]);
  assert.deepEqual(graph.readyTicketIds(new Set(["a", "b", "c"])), ["d", "x"]);
});

test("dependency graph keeps missing references blocked without invalidating unrelated work", () => {
  const graph = buildDependencyGraph([ticket("blocked", ["missing"]), ticket("ready")]);
  assert.deepEqual(graph.missingDependencies.get("blocked"), ["missing"]);
  assert.deepEqual(graph.readyTicketIds(new Set()), ["ready"]);
});

test("dependency graph rejects duplicate IDs, cycles, and incompatible edges", () => {
  assert.throws(() => buildDependencyGraph([ticket("a"), ticket("a")]), /Duplicate ticket ID a/);
  assert.throws(() => buildDependencyGraph([ticket("a", ["b"]), ticket("b", ["a"])]), /cycle.*a.*b/i);
  assert.throws(() => buildDependencyGraph([ticket("a"), ticket("b", ["a"], "git@github.com:acme/other.git")]), /repository\/base branch/i);
});
