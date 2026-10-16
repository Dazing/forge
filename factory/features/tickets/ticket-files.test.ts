import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitProviderRegistry } from "../../infrastructure/git-provider/create-git-provider.js";
import type { GitProviderRegistry } from "../../infrastructure/git-provider/git-provider.js";
import { listTicketPaths, parseTicketSource, TicketMetadataError, type Ticket } from "./index.js";

const github = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc" });
const azure = createGitProviderRegistry({ AZURE_DEVOPS_PAT: "vso_pat_secret_123" });

async function ticketPath(frontMatter: string, body: string, name = "ticket.md"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-tickets-"));
  const path = join(dir, name);
  const declared = /^id:/m.test(frontMatter) ? frontMatter : `id: ticket-test\n${frontMatter}`;
  await writeFile(path, `---\n${declared}\n---\n${body}`);
  return path;
}
async function parseFile(path: string, providers: GitProviderRegistry): Promise<Ticket> {
  return parseTicketSource(await readFile(path, "utf8"), providers, path);
}

test("defaults base branch to main and keeps the canonical SSH URL as the clone target", async () => {
  const ticket = await parseFile(await ticketPath("name: Fix Login Redirect\nrepository: git@github.com:acme/app.git", "# Fix login redirect\n\nBody."), github);
  assert.equal(ticket.baseBranch, "main");
  assert.equal(ticket.repository, "git@github.com:acme/app.git");
  assert.equal(ticket.slug, "fix-login-redirect");
  assert.equal(ticket.title, "Fix login redirect");
});

test("accepts the canonical Azure DevOps SSH URL", async () => {
  const ticket = await parseFile(await ticketPath("name: fix-login\nrepository: git@ssh.dev.azure.com:v3/Contoso Team/Web App/fix-login\nbaseBranch: release/2.1", "# Fix"), azure);
  assert.equal(ticket.repository, "git@ssh.dev.azure.com:v3/Contoso Team/Web App/fix-login");
  assert.equal(ticket.baseBranch, "release/2.1");
});

test("a GitHub-only invocation blocks Azure work naming AZURE_DEVOPS_PAT", async () => {
  await assert.rejects(parseFile(await ticketPath("name: fix\nrepository: git@ssh.dev.azure.com:v3/contoso/web/fix-login", "# Fix"), github), /AZURE_DEVOPS_PAT is not configured; Azure DevOps work is blocked/);
});

test("an Azure DevOps-only invocation blocks GitHub work naming GITHUB_TOKEN", async () => {
  await assert.rejects(parseFile(await ticketPath("name: fix\nrepository: git@github.com:acme/app.git", "# Fix"), azure), /GITHUB_TOKEN is not configured; GitHub work is blocked/);
});

for (const repository of ["https://github.com/acme/app.git", "/srv/repos/app.git", "git@github.acme.com:acme/app.git"]) {
  test(`rejects non-canonical GitHub repository ${repository}`, async () => {
    await assert.rejects(parseFile(await ticketPath(`name: fix\nrepository: ${repository}`, "# Fix"), github), TicketMetadataError);
  });
}

test("honors an explicit base branch", async () => {
  const ticket = await parseFile(await ticketPath("name: fix\nrepository: git@github.com:acme/app.git\nbaseBranch: release/2.1", "# Fix"), github);
  assert.equal(ticket.baseBranch, "release/2.1");
});

test("normalizes name once to lowercase kebab-case slug", async () => {
  const ticket = await parseFile(await ticketPath("name: Fix  Login__Redirect 2\nrepository: git@github.com:acme/app.git", "# Fix"), github);
  assert.equal(ticket.slug, "fix-login-redirect-2");
});

test("rejects empty normalized names", async () => {
  await assert.rejects(parseFile(await ticketPath("name: ___\nrepository: git@github.com:acme/app.git", "# Fix"), github), /Normalized name is empty/);
});

test("rejects missing required fields", async () => {
  await assert.rejects(parseFile(await ticketPath("name: fix", "# Fix"), github), TicketMetadataError);
});

test("rejects malformed front matter", async () => {
  await assert.rejects(parseFile(await ticketPath("name: fix\nrepository: [unclosed", "# Fix"), github), TicketMetadataError);
});

test("uses declared ticket identity and dependency references instead of source hashes", async () => {
  const path = await ticketPath("id: ticket-abc\nname: fix\nrepository: git@github.com:acme/app.git\ndependsOnTickets: [ticket-base]", "# Fix\n\nBody.");
  const ticket = await parseFile(path, github);
  assert.equal(ticket.id, "ticket-abc");
  assert.deepEqual(ticket.dependsOnTickets, ["ticket-base"]);
});

test("front matter is removed from prompt content and declared identity is stable", async () => {
  const path = await ticketPath("id: ticket-stable\nname: fix\nrepository: git@github.com:acme/app.git", "# Fix\n\nBody.");
  const ticket = await parseFile(path, github);
  assert.equal(ticket.content, "# Fix\n\nBody.");
  assert.equal(ticket.id, "ticket-stable");
});

test("keeps the requirements fingerprint stable across runner lifecycle text and changes it for authored edits", async () => {
  const frontMatter = "id: ticket-stable\nname: fix\nrepository: git@github.com:acme/app.git";
  const path = await ticketPath(frontMatter, "# Fix\n\nBody.");
  const original = await parseFile(path, github);
  await writeFile(path, `---\n${frontMatter}\n---\n# Fix\n\nBody.\n## Attempt 1a2b3c (2026-10-11T07:00:00.000Z)\n\n- Attempt ID: \`1a2b3c\`\n- Workspace: \`/tmp/work\`\n- Branch: \`ticket\`\n- Repository: \`git@github.com:acme/app.git\`\n- Base branch: \`main\`\n## Stage checkpoint implement (2026-10-11T07:10:00.000Z)\n\n- Attempt ID: \`1a2b3c\`\n- Stage: \`implement\`\n- Parent commit: \`abc\`\n- Checkpoint commit: \`def\`\n- Changes: changed\n- Agent log: \`implement.log\`\n`);
  const annotated = await parseFile(path, github);
  assert.equal(annotated.id, original.id);
  assert.equal(annotated.sourceHash === original.sourceHash, false);
  assert.equal(annotated.requirementsHash, original.requirementsHash);
  await writeFile(path, `---\n${frontMatter}\n---\n# Fix\n\nChanged authored requirement.`);
  assert.notEqual((await parseFile(path, github)).requirementsHash, original.requirementsHash);
});

test("rejects duplicate and self dependencies", async () => {
  await assert.rejects(parseFile(await ticketPath("id: ticket-a\nname: fix\nrepository: git@github.com:acme/app.git\ndependsOnTickets: [ticket-a]", "# Fix"), github), /must not depend on itself/);
  await assert.rejects(parseFile(await ticketPath("id: ticket-a\nname: fix\nrepository: git@github.com:acme/app.git\ndependsOnTickets: [ticket-b, ticket-b]", "# Fix"), github), /duplicate dependency/);
});

test("lists root-level Markdown tickets in sorted order, ignoring nested and non-Markdown files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-queue-"));
  await writeFile(join(dir, "b.md"), "x");
  await writeFile(join(dir, "a.md"), "x");
  await writeFile(join(dir, "notes.txt"), "x");
  await mkdir(join(dir, "done"));
  await writeFile(join(dir, "done", "c.md"), "x");
  assert.deepEqual(await listTicketPaths(dir), [join(dir, "a.md"), join(dir, "b.md")]);
});
