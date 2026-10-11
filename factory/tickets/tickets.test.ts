import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { listTicketPaths, loadTicket, planSchema, validatePlan, TicketMetadataError, type Ticket } from "./tickets.js";

async function ticketPath(frontMatter: string, body: string, name = "ticket.md"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-ticket-"));
  const path = join(dir, name);
  await writeFile(path, `---\n${frontMatter}\n---\n${body}`);
  return path;
}

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "0123456789abcdef",
    name: "fix-login-redirect",
    slug: "fix-login-redirect",
    title: "Fix login redirect",
    path: "/tmp/ticket.md",
    content: "# Fix login redirect\n",
    repository: "git@github.com:acme/app.git",
    githubOwner: "acme",
    githubRepository: "app",
    baseBranch: "main",
    ...overrides,
  };
}

test("defaults base branch to main and derives GitHub owner/repository from the SSH URL", async () => {
  const loaded = await loadTicket(
    await ticketPath("name: fix-login-redirect\nrepository: git@github.com:acme/app.git", "# Fix login redirect\nBody."),
  );
  assert.equal(loaded.baseBranch, "main");
  assert.equal(loaded.githubOwner, "acme");
  assert.equal(loaded.githubRepository, "app");
  assert.equal(loaded.repository, "git@github.com:acme/app.git");
  assert.equal(loaded.name, "fix-login-redirect");
  assert.equal(loaded.slug, "fix-login-redirect");
  assert.equal(loaded.title, "Fix login redirect");
});

test("honors an explicit base branch", async () => {
  const loaded = await loadTicket(
    await ticketPath("name: fix-login-redirect\nrepository: git@github.com:acme/app.git\nbaseBranch: release/2.1", "Body."),
  );
  assert.equal(loaded.baseBranch, "release/2.1");
});

test("normalizes name once to lowercase kebab-case slug", async () => {
  const spaced = await loadTicket(
    await ticketPath("name: Fix Login Redirect!\nrepository: git@github.com:acme/app.git", "Body."),
  );
  assert.equal(spaced.slug, "fix-login-redirect");

  const punctuated = await loadTicket(
    await ticketPath("name: __Fix__Login__v2__\nrepository: git@github.com:acme/app.git", "Body."),
  );
  assert.equal(punctuated.slug, "fix-login-v2");
  assert.equal(punctuated.title, "fix-login-v2", "title falls back to the normalized name when no H1 exists");
});

test("rejects empty normalized names", async () => {
  await assert.rejects(
    loadTicket(await ticketPath("name: ___\nrepository: git@github.com:acme/app.git", "Body.")),
    (error: unknown) => {
      assert.ok(error instanceof TicketMetadataError);
      assert.match(error.failure.operation, /normalizing/);
      return true;
    },
  );
});

for (const repository of [
  "https://github.com/acme/app.git",
  "git@github.acme.com:acme/app.git",
  "/srv/repos/app.git",
  "ssh://git@github.com/acme/app.git",
  "git@github.com:acme/app",
]) {
  test(`rejects non-github.com SSH repository ${repository}`, async () => {
    await assert.rejects(
      loadTicket(await ticketPath(`name: fix-login-redirect\nrepository: ${repository}`, "Body.")),
      TicketMetadataError,
    );
  });
}

test("rejects missing required fields", async () => {
  await assert.rejects(loadTicket(await ticketPath("repository: git@github.com:acme/app.git", "Body.")), TicketMetadataError);
  await assert.rejects(loadTicket(await ticketPath("name: fix-login-redirect", "Body.")), TicketMetadataError);
});

test("rejects malformed front matter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-ticket-"));

  const noBlock = join(dir, "no-block.md");
  await writeFile(noBlock, "name: fix\n# Body");
  await assert.rejects(loadTicket(noBlock), TicketMetadataError);

  const unterminated = join(dir, "unterminated.md");
  await writeFile(unterminated, "---\nname: fix\nrepository: git@github.com:acme/app.git\n");
  await assert.rejects(loadTicket(unterminated), TicketMetadataError);

  const invalidYaml = join(dir, "invalid.md");
  await writeFile(invalidYaml, "---\nname: [unclosed\n---\nBody");
  await assert.rejects(loadTicket(invalidYaml), TicketMetadataError);

  const empty = join(dir, "empty.md");
  await writeFile(empty, "   \n");
  await assert.rejects(loadTicket(empty), TicketMetadataError);
});

test("front matter is removed from prompt content and the ID hashes the complete source", async () => {
  const loaded = await loadTicket(
    await ticketPath("name: fix-login-redirect\nrepository: git@github.com:acme/app.git", "# Fix login redirect\nBody text."),
  );
  assert.ok(loaded.content.startsWith("# Fix login redirect"));
  assert.ok(!loaded.content.includes("repository:"));

  const sameBody = await loadTicket(
    await ticketPath("name: other-name\nrepository: git@github.com:acme/app.git", "# Fix login redirect\nBody text."),
  );
  assert.notEqual(loaded.id, sameBody.id, "front matter participates in the content hash");
  assert.equal(loaded.id.length, 16);
});

test("lists root-level Markdown tickets in sorted order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-tickets-"));
  await writeFile(join(dir, "b-ticket.md"), "b");
  await writeFile(join(dir, "a-ticket.md"), "a");
  await writeFile(join(dir, "notes.txt"), "not a ticket");
  const paths = await listTicketPaths(dir);
  assert.deepEqual(paths.map((path) => path.split("/").pop()), ["a-ticket.md", "b-ticket.md"]);
});

test("planner contract selects by id and title only and rejects a branch echo", () => {
  const valid = planSchema.safeParse({ tickets: [{ id: "0123456789abcdef", title: "Fix login redirect" }] });
  assert.ok(valid.success);
  const withBranch = planSchema.safeParse({
    tickets: [{ id: "0123456789abcdef", title: "Fix login redirect", branch: "sandcastle/ticket-0123456789abcdef" }],
  });
  assert.ok(!withBranch.success);
});

test("validatePlan accepts id/title-only selections", () => {
  const available = new Map([[ticket().id, ticket()]]);
  const planned = validatePlan([{ id: "0123456789abcdef", title: "Fix login redirect" }], available, new Set());
  assert.deepEqual(planned, [{ id: "0123456789abcdef", title: "Fix login redirect" }]);
});

test("validatePlan rejects completed, unknown, duplicated, and title-mutated selections", () => {
  const available = new Map([[ticket().id, ticket()]]);
  assert.throws(() => validatePlan([{ id: "0123456789abcdef", title: "Fix login redirect" }], available, new Set(["0123456789abcdef"])), /completed/);
  assert.throws(() => validatePlan([{ id: "deadbeefdeadbeef", title: "Fix login redirect" }], available, new Set()), /unknown/);
  assert.throws(
    () => validatePlan([{ id: "0123456789abcdef", title: "Fix login redirect" }, { id: "0123456789abcdef", title: "Fix login redirect" }], available, new Set()),
    /more than once/,
  );
  assert.throws(() => validatePlan([{ id: "0123456789abcdef", title: "Renamed by planner" }], available, new Set()), /changed title/);
});
