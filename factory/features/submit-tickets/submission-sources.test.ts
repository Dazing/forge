import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitProviderRegistry } from "../../infrastructure/git-provider/create-git-provider.js";
import { canonicalRepositoryUrl, expandTicketPaths, findDependencyCycle, readTicketSources, submissionProviderRegistry, validateBatch } from "./submission-sources.js";

// Path expansion and pre-write batch validation: the batch is fully validated before the first write,
// so a bad ticket can never leave a partially submitted batch behind.

const PROVIDER = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc" }).resolve("git@github.com:acme/api.git");
const NO_KNOWN: ReadonlyMap<string, number> = new Map();

function source(id: string, options: Readonly<{ dependsOn?: readonly string[]; repository?: string }> = {}): string {
  return [
    "---",
    `id: ${id}`,
    `name: ${id} ticket`,
    `repository: ${options.repository ?? "git@github.com:acme/api.git"}`,
    "baseBranch: main",
    ...(options.dependsOn === undefined ? [] : [`dependsOnTickets: [${options.dependsOn.join(", ")}]`]),
    "---",
    "",
    `# ${id} ticket`,
    "",
  ].join("\n");
}

async function scratch(entries: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "submission-sources-"));
  for (const [name, content] of Object.entries(entries)) {
    const path = join(directory, name);
    if (name.includes("/")) {
      await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    }
    await writeFile(path, content, "utf8");
  }
  return directory;
}

test("a directory expands to its top-level Markdown tickets in sorted order", async () => {
  const directory = await scratch({
    "b.md": source("T-2"),
    "a.md": source("T-1"),
    "notes.txt": "not a ticket",
    "nested/c.md": source("T-3"),
  });

  const expanded = await expandTicketPaths([directory], directory);

  assert.deepEqual(expanded.map((path) => path.slice(directory.length + 1)), ["a.md", "b.md"]);
});

test("a directory with only nested tickets is refused without discarding other inputs", async (t) => {
  const directory = await scratch({ "issues/a.md": source("T-1"), "other/b.md": source("T-2") });
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const paths of [[directory], [join(directory, "other/b.md"), directory]]) {
    await assert.rejects(() => expandTicketPaths(paths, directory), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(directory));
      assert.match(error.message, /no top-level Markdown tickets/);
      assert.match(error.message, /not recursive/);
      return true;
    });
  }
  assert.deepEqual(await expandTicketPaths([join(directory, "issues")], directory), [join(directory, "issues/a.md")]);
  assert.deepEqual(await expandTicketPaths([join(directory, "**/*.md")], directory), [join(directory, "issues/a.md"), join(directory, "other/b.md")]);
});

test("an empty directory is refused instead of returning an empty batch", async (t) => {
  const directory = await scratch({});
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(() => expandTicketPaths([directory], directory), /no top-level Markdown tickets/);
});

test("a glob expands, duplicates collapse, and an unmatched pattern fails", async () => {
  const directory = await scratch({ "a.md": source("T-1"), "b.md": source("T-2"), "nested/c.md": source("T-3") });

  const globbed = await expandTicketPaths(["*.md", join(directory, "a.md"), "nested/**/*.md"], directory);

  assert.deepEqual(globbed.map((path) => path.slice(directory.length + 1)), ["a.md", "b.md", "nested/c.md"]);
  await assert.rejects(() => expandTicketPaths(["missing/*.md"], directory), /matches no Markdown ticket|does not exist/);
  await assert.rejects(() => expandTicketPaths(["absent.md"], directory), /does not exist/);
});

test("an unreadable source is reported as a problem for its own path", async () => {
  const directory = await scratch({ "a.md": source("T-1") });
  const missing = join(directory, "gone.md");

  const { files, problems } = await readTicketSources([join(directory, "a.md"), missing]);

  assert.deepEqual(files.map((file) => file.path), [join(directory, "a.md")]);
  assert.deepEqual(problems.map((problem) => problem.path), [missing]);
});

test("the client provider accepts GitHub repositories in either accepted form and rejects the rest", () => {
  const providers = submissionProviderRegistry(PROVIDER);

  assert.equal(providers.names[0], "github");
  assert.deepEqual(providers.secrets, ["gh_secret_abc"]);
  assert.equal(canonicalRepositoryUrl("acme/api"), "git@github.com:acme/api.git");
  assert.equal(canonicalRepositoryUrl("git@github.com:acme/api.git"), "git@github.com:acme/api.git");
  assert.throws(() => providers.resolve("git@ssh.dev.azure.com:v3/org/proj/repo"), /github/);
});

test("batch validation rejects duplicates, unknown dependencies, self-dependencies, foreign repositories, and cycles", () => {
  const cases: ReadonlyArray<readonly [string, readonly { path: string; source: string }[], RegExp]> = [
    ["duplicate", [{ path: "a.md", source: source("T-1") }, { path: "b.md", source: source("T-1") }], /unique per backlog repository/],
    ["unknown", [{ path: "b.md", source: source("T-2", { dependsOn: ["T-9"] }) }], /neither this batch nor the backlog/],
    ["self", [{ path: "a.md", source: source("T-1", { dependsOn: ["T-1"] }) }], /itself/],
    ["foreign", [{ path: "a.md", source: source("T-1", { repository: "git@ssh.dev.azure.com:v3/org/proj/repo" }) }], /github/],
    ["cycle", [{ path: "a.md", source: source("T-1", { dependsOn: ["T-2"] }) }, { path: "b.md", source: source("T-2", { dependsOn: ["T-1"] }) }], /Dependency cycle/],
  ];
  for (const [label, files, expectation] of cases) {
    const validation = validateBatch({ files, providers: submissionProviderRegistry(PROVIDER), provider: PROVIDER, knownTicketIds: NO_KNOWN });

    assert.deepEqual(validation.sources, [], label);
    assert.match(validation.problems.map((problem) => problem.reason).join("\n"), expectation, label);
  }
});

test("a dependency already in the backlog and an explicit repository override both validate", () => {
  const validation = validateBatch({
    files: [{ path: "b.md", source: source("T-2", { dependsOn: ["T-1"] }) }],
    providers: submissionProviderRegistry(PROVIDER),
    provider: PROVIDER,
    repositoryOverride: "acme/other",
    knownTicketIds: new Map([["T-1", 60]]),
  });

  assert.deepEqual(validation.problems, []);
  assert.deepEqual(validation.sources.map((entry) => entry.ticket.id), ["T-2"]);
});

test("a repository override the provider rejects is reported against the ticket", () => {
  const validation = validateBatch({
    files: [{ path: "a.md", source: source("T-1") }],
    providers: submissionProviderRegistry(PROVIDER),
    provider: PROVIDER,
    repositoryOverride: "git@ssh.dev.azure.com:v3/org/proj/repo",
    knownTicketIds: NO_KNOWN,
  });

  assert.deepEqual(validation.sources, []);
  assert.match(validation.problems[0]!.reason, /Repository git@ssh\.dev\.azure\.com:v3\/org\/proj\/repo is not usable with the github provider/);
});

test("findDependencyCycle names the cycle it finds and nothing for an acyclic graph", () => {
  assert.deepEqual(findDependencyCycle([{ id: "T-1", dependsOn: ["T-2"] }, { id: "T-2", dependsOn: ["T-1"] }]), ["T-1", "T-2", "T-1"]);
  assert.equal(findDependencyCycle([{ id: "T-1", dependsOn: ["T-2"] }, { id: "T-2", dependsOn: [] }]), undefined);
});
