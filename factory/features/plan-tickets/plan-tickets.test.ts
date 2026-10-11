import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../../infrastructure/git-provider/git.js";
import type { AgentRunRequest, AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import type { Ticket } from "../tickets/index.js";
import { planSchema, validatePlan } from "./plan-schema.js";
import { planTickets } from "./plan-tickets.js";

function ticket(id: string, title: string): Ticket {
  return { id, name: title, slug: title.toLowerCase(), title, path: `/tickets/${title}.md`, content: `# ${title}`, repository: "git@github.com:acme/app.git", baseBranch: "main" };
}

/** A runAgent seam that returns a fixed plan output and can mutate the factory checkout mid-run. */
function fakeRunAgent(output: unknown, mutate?: () => Promise<void>, completionSignal = "</plan>"): AgentRunner {
  return async <TOutput>(request: AgentRunRequest<TOutput>) => {
    if (mutate) {
      await mutate();
    }
    return { iterations: [], commits: [], stdout: "", branch: "agent-tickets/planner", completionSignal, output: output as TOutput };
  };
}

test("planner contract selects by id and title only and rejects a branch echo", () => {
  const valid = planSchema.safeParse({ tickets: [{ id: "0123456789abcdef", title: "Fix login" }] });
  assert.ok(valid.success);
  assert.equal(planSchema.safeParse({ tickets: [{ id: "0123456789abcdef", title: "Fix login", branch: "agent-tickets/fix-login-1" }] }).success, false);
  assert.equal(planSchema.safeParse({ tickets: [{ id: "aaaaaaaaaaaaaaaa", title: "A" }, { id: "bbbbbbbbbbbbbbbb", title: "B" }] }).success, false);
});

test("validatePlan accepts id/title-only selections", () => {
  const available = new Map([[ticket("0123456789abcdef", "Fix login").id, ticket("0123456789abcdef", "Fix login")]]);
  assert.deepEqual(validatePlan([{ id: "0123456789abcdef", title: "Fix login" }], available, new Set()), [{ id: "0123456789abcdef", title: "Fix login" }]);
});

test("validatePlan rejects completed, unknown, duplicated, and title-mutated selections", () => {
  const available = new Map([[ticket("0123456789abcdef", "Fix login").id, ticket("0123456789abcdef", "Fix login")]]);
  assert.throws(() => validatePlan([{ id: "0123456789abcdef", title: "Fix login" }], available, new Set(["0123456789abcdef"])), /already completed/);
  assert.throws(() => validatePlan([{ id: "ffffffffffffffff", title: "Ghost" }], available, new Set()), /unknown ticket/);
  assert.throws(
    () => validatePlan([{ id: "0123456789abcdef", title: "Fix login" }, { id: "0123456789abcdef", title: "Fix login" }], available, new Set()),
    /more than once/,
  );
  assert.throws(() => validatePlan([{ id: "0123456789abcdef", title: "Fix login!" }], available, new Set()), /changed title/);
});

async function factoryCheckout(): Promise<string> {
  const factory = await mkdtemp(join(tmpdir(), "sandcastle-factory-"));
  await runCommand("git", ["init", "-b", "main", factory], "initializing factory checkout");
  await writeFile(join(factory, "README.md"), "# Factory\n");
  await runCommand("git", ["-C", factory, "add", "README.md"], "staging factory file");
  await runCommand("git", ["-C", factory, "-c", "user.email=factory@test", "-c", "user.name=Factory", "commit", "-m", "init"], "committing factory file");
  return factory;
}

test("planning fails when the planner commits in the factory checkout", async () => {
  const factory = await factoryCheckout();
  const mutate = async () => {
    await writeFile(join(factory, "intruder.md"), "committed by planner\n");
    await runCommand("git", ["-C", factory, "add", "intruder.md"], "staging intruder");
    await runCommand("git", ["-C", factory, "-c", "user.email=factory@test", "-c", "user.name=Factory", "commit", "-m", "intruder"], "committing intruder");
  };
  await assert.rejects(
    planTickets({ pending: [], completed: [], factoryRoot: factory, harness: "pi", runAgent: fakeRunAgent({ tickets: [] }, mutate) }),
    /planning stage changed factory commits/,
  );
});

test("planning fails when the planner leaves untracked files in the factory checkout", async () => {
  const factory = await factoryCheckout();
  const mutate = async () => writeFile(join(factory, "scratch.md"), "untracked\n");
  await assert.rejects(
    planTickets({ pending: [], completed: [], factoryRoot: factory, harness: "pi", runAgent: fakeRunAgent({ tickets: [] }, mutate) }),
    /planning stage changed factory worktree status/,
  );
});

test("planning rejects a selection of an already terminal ticket", async () => {
  const factory = await factoryCheckout();
  const pending = [ticket("0123456789abcdef", "Fix login")];
  const runAgent = fakeRunAgent({ tickets: [{ id: "0123456789abcdef", title: "Fix login" }] });
  await assert.rejects(planTickets({ pending, completed: ["0123456789abcdef"], factoryRoot: factory, harness: "pi", runAgent }), /already completed/);
});

test("planning rejects schema-valid output without its closing-tag completion signal", async () => {
  const factory = await factoryCheckout();
  await assert.rejects(
    planTickets({ pending: [], completed: [], factoryRoot: factory, harness: "pi", runAgent: fakeRunAgent({ tickets: [] }, undefined, "<promise>COMPLETE</promise>") }),
    /planner did not complete/,
  );
});
