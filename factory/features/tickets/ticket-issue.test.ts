import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitProviderRegistry } from "../../infrastructure/git-provider/create-git-provider.js";
import { declaredRepository, parseAuthoredIssueSnapshot, parseTicketSource, TicketMetadataError } from "./index.js";

const github = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc" });
const identity = { backlogRepository: "acme/backlog", number: 7, nodeId: "I_kwDO1234", url: "https://github.com/acme/backlog/issues/7" };
const authored = "---\nid: ticket-remote\nname: Fix Login\nrepository: git@github.com:acme/app.git\ndependsOnTickets: [ticket-base]\n---\n# Fix login redirect\n\nBody.";

test("an issue body parses to the declared identity, hashes, title, and dependencies", () => {
  const snapshot = parseAuthoredIssueSnapshot(identity, authored, github);
  assert.equal(snapshot.identity, identity);
  assert.equal(snapshot.source, authored);
  assert.equal(snapshot.requirementsHash, snapshot.ticket.requirementsHash);
  assert.equal(snapshot.ticket.id, "ticket-remote");
  assert.equal(snapshot.ticket.title, "Fix login redirect");
  assert.equal(snapshot.ticket.slug, "fix-login");
  assert.deepEqual(snapshot.ticket.dependsOnTickets, ["ticket-base"]);
  assert.equal(snapshot.ticket.path, identity.url);
  assert.match(snapshot.ticket.sourceHash, /^[a-f0-9]{64}$/);
});

test("a malformed issue body is a metadata failure identified by its issue URL, not a file path", () => {
  assert.throws(
    () => parseTicketSource("---\nname: Fix\n---\n# Fix\n", github, identity.url),
    (error: unknown) => error instanceof TicketMetadataError && error.path === identity.url && /repository/.test(error.failure.stderr),
  );
});

test("self and duplicate dependency declarations are rejected in an issue body", () => {
  assert.throws(() => parseTicketSource("---\nid: t\ntitle: n\nname: n\nrepository: git@github.com:acme/app.git\ndependsOnTickets: [t]\n---\n# Fix\n", github, identity.url), /must not depend on itself \(t\)/);
  assert.throws(() => parseTicketSource("---\nid: t\nname: n\nrepository: git@github.com:acme/app.git\ndependsOnTickets: [base, base]\n---\n# Fix\n", github, identity.url), /duplicate dependency base/);
});

test("appended runner records keep the requirements hash and change the full-source hash", () => {
  const annotated = `${authored}\n## Attempt 1a2b3c (2026-10-11T07:00:00.000Z)\n\n- Attempt ID: \`1a2b3c\`\n- Workspace: \`/tmp/work\`\n- Branch: \`ticket\`\n- Repository: \`git@github.com:acme/app.git\`\n- Base branch: \`main\``;
  const original = parseTicketSource(authored, github, identity.url);
  const withRecord = parseTicketSource(annotated, github, identity.url);
  assert.equal(withRecord.requirementsHash, original.requirementsHash);
  assert.notEqual(withRecord.sourceHash, original.sourceHash);
});

test("the target repository is read from front matter only, and an absent declaration is undefined", () => {
  assert.equal(declaredRepository(authored), "git@github.com:acme/app.git");
  assert.equal(declaredRepository("# Ticket\n\nrepository: git@github.com:acme/app.git\n"), undefined);
  assert.equal(declaredRepository("---\nname: Fix\nrepository: [unclosed\n---\n# Fix\n"), undefined);
  assert.equal(declaredRepository("---\nname: Fix\n---\n# Fix\n"), undefined);
});
