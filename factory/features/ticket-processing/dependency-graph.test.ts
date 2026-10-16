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

test("dependency graph rejects duplicate IDs", () => {
  assert.throws(() => buildDependencyGraph([ticket("a"), ticket("a")]), /Duplicate ticket ID a/);
});

test("cycles and incompatible edges block only their own dependency chains", () => {
  const graph = buildDependencyGraph([
    ticket("a", ["b"]),
    ticket("b", ["a"]),
    ticket("cycle-child", ["a"]),
    ticket("parent"),
    ticket("wrong-repository", ["parent"], "git@github.com:acme/other.git"),
    ticket("wrong-base", ["parent"], undefined, "release"),
    ticket("ready"),
  ]);
  assert.match(graph.invalidDependencies.get("a")!, /cycle.*a.*b/i);
  assert.match(graph.invalidDependencies.get("b")!, /cycle.*a.*b/i);
  assert.match(graph.invalidDependencies.get("wrong-repository")!, /repository\/base branch/i);
  assert.match(graph.invalidDependencies.get("wrong-base")!, /repository\/base branch/i);
  assert.equal(graph.invalidDependencies.has("parent"), false);
  assert.equal(graph.invalidDependencies.has("ready"), false);
  assert.deepEqual(graph.readyTicketIds(new Set()), ["parent", "ready"]);
  assert.deepEqual(graph.readyTicketIds(new Set(["parent"])), ["ready"]);
});

test("a merged parent absent from discovery satisfies a new child's dependency", () => {
  const graph = buildDependencyGraph([ticket("child", ["merged"]), ticket("grandchild", ["child"])], new Set(["merged"]));
  assert.deepEqual([...graph.missingDependencies], []);
  assert.deepEqual([...graph.invalidDependencies], []);
  assert.deepEqual(graph.readyTicketIds(new Set()), ["child"]);
  assert.deepEqual(graph.readyTicketIds(new Set(["child"])), ["grandchild"]);
});
