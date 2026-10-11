import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AzureDevOpsProvider } from "../../infrastructure/git-provider/azure-devops-provider.js";
import { GitHubProvider } from "../../infrastructure/git-provider/github-provider.js";
import { listTicketPaths, loadTicket, TicketMetadataError } from "./index.js";

const github = new GitHubProvider("gh_secret_abc");
const azure = new AzureDevOpsProvider("vso_pat_secret_123");

async function ticketPath(frontMatter: string, body: string, name = "ticket.md"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-tickets-"));
  const path = join(dir, name);
  await writeFile(path, `---\n${frontMatter}\n---\n${body}`);
  return path;
}

test("defaults base branch to main and keeps the canonical SSH URL as the clone target", async () => {
  const ticket = await loadTicket(await ticketPath("name: Fix Login Redirect\nrepository: git@github.com:acme/app.git", "# Fix login redirect\n\nBody."), github);
  assert.equal(ticket.baseBranch, "main");
  assert.equal(ticket.repository, "git@github.com:acme/app.git");
  assert.equal(ticket.slug, "fix-login-redirect");
  assert.equal(ticket.title, "Fix login redirect");
});

test("accepts the canonical Azure DevOps SSH URL", async () => {
  const ticket = await loadTicket(await ticketPath("name: fix-login\nrepository: git@ssh.dev.azure.com:v3/Contoso Team/Web App/fix-login\nbaseBranch: release/2.1", "# Fix"), azure);
  assert.equal(ticket.repository, "git@ssh.dev.azure.com:v3/Contoso Team/Web App/fix-login");
  assert.equal(ticket.baseBranch, "release/2.1");
});

test("the GitHub provider rejects the Azure SSH URL", async () => {
  await assert.rejects(loadTicket(await ticketPath("name: fix\nrepository: git@ssh.dev.azure.com:v3/contoso/web/fix-login", "# Fix"), github), /git@github\.com/);
});

test("the Azure DevOps provider rejects the GitHub SSH URL", async () => {
  await assert.rejects(loadTicket(await ticketPath("name: fix\nrepository: git@github.com:acme/app.git", "# Fix"), azure), /git@ssh\.dev\.azure\.com/);
});

for (const repository of ["https://github.com/acme/app.git", "/srv/repos/app.git", "git@github.acme.com:acme/app.git"]) {
  test(`rejects non-canonical GitHub repository ${repository}`, async () => {
    await assert.rejects(loadTicket(await ticketPath(`name: fix\nrepository: ${repository}`, "# Fix"), github), TicketMetadataError);
  });
}

test("honors an explicit base branch", async () => {
  const ticket = await loadTicket(await ticketPath("name: fix\nrepository: git@github.com:acme/app.git\nbaseBranch: release/2.1", "# Fix"), github);
  assert.equal(ticket.baseBranch, "release/2.1");
});

test("normalizes name once to lowercase kebab-case slug", async () => {
  const ticket = await loadTicket(await ticketPath("name: Fix  Login__Redirect 2\nrepository: git@github.com:acme/app.git", "# Fix"), github);
  assert.equal(ticket.slug, "fix-login-redirect-2");
});

test("rejects empty normalized names", async () => {
  await assert.rejects(loadTicket(await ticketPath("name: ___\nrepository: git@github.com:acme/app.git", "# Fix"), github), /Normalized name is empty/);
});

test("rejects missing required fields", async () => {
  await assert.rejects(loadTicket(await ticketPath("name: fix", "# Fix"), github), TicketMetadataError);
});

test("rejects malformed front matter", async () => {
  await assert.rejects(loadTicket(await ticketPath("name: fix\nrepository: [unclosed", "# Fix"), github), TicketMetadataError);
});

test("front matter is removed from prompt content and the ID hashes the complete source", async () => {
  const path = await ticketPath("name: fix\nrepository: git@github.com:acme/app.git", "# Fix\n\nBody.");
  const ticket = await loadTicket(path, github);
  assert.equal(ticket.content, "# Fix\n\nBody.");
  assert.equal(ticket.id, createHash("sha256").update(`---\nname: fix\nrepository: git@github.com:acme/app.git\n---\n# Fix\n\nBody.`).digest("hex").slice(0, 16));
});

test("lists root-level Markdown tickets in sorted order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandcastle-queue-"));
  await writeFile(join(dir, "b.md"), "x");
  await writeFile(join(dir, "a.md"), "x");
  await writeFile(join(dir, "notes.txt"), "x");
  await mkdir(join(dir, "done"));
  await writeFile(join(dir, "done", "c.md"), "x");
  assert.deepEqual(await listTicketPaths(dir), [join(dir, "a.md"), join(dir, "b.md")]);
});
