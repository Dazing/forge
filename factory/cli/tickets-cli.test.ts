import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BacklogConfigurationError, type GitHubBacklog } from "../infrastructure/github-backlog/index.js";
import { createGitProviderRegistry } from "../infrastructure/git-provider/create-git-provider.js";
import { FakeBacklog } from "../features/submit-tickets/test-backlog.js";
import type { TicketsRuntime } from "./tickets-cli.js";
import { parseTicketsArgs, runTicketsSubmission } from "./tickets-cli.js";

// The `tickets submit` host: usage before any credential, exit codes the agent can act on, and a report
// that never carries a token.

const PROJECT_URL = "https://github.com/orgs/acme/projects/7";
const ENV = { FORGE_BACKLOG_TOKEN: "backlog_secret_xyz", GITHUB_TOKEN: "gh_secret_abc", FORGE_BACKLOG_REPOSITORY: "acme/backlog", FORGE_BACKLOG_PROJECT_URL: PROJECT_URL };
const PROVIDER = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc" }).resolve("git@github.com:acme/api.git");

function ticketSource(id: string, name = "First ticket"): string {
  return `---\nid: ${id}\nname: ${name}\nrepository: git@github.com:acme/api.git\nbaseBranch: main\n---\n\n# ${name}\n\nRequirements for ${id}.\n`;
}

async function ticketDirectory(source = ticketSource("T-1")): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tickets-cli-"));
  await writeFile(join(directory, "first.md"), source, "utf8");
  return directory;
}

/** Run the host with stdout captured and every external seam injected; `progress` is the log seam, `printed` is what the process writes to stdout. */
async function run(argv: readonly string[], backlog: GitHubBacklog = new FakeBacklog(), extra: Partial<TicketsRuntime> = {}) {
  const printed: string[] = [];
  const progress: string[] = [];
  const loaded: string[] = [];
  const seen: NodeJS.ProcessEnv[] = [];
  const order: string[] = [];
  const stdout = console.log;
  console.log = (...args: unknown[]) => printed.push(args.map((value) => String(value)).join(" "));
  try {
    const exitCode = await runTicketsSubmission({
      argv,
      env: ENV,
      loadEnvironment: (path: string) => { order.push("loadEnvironment"); loaded.push(path); },
      createBacklog: async (env: NodeJS.ProcessEnv) => { order.push("createBacklog"); seen.push(env); return backlog; },
      createProvider: () => PROVIDER,
      log: (line: string) => progress.push(line),
      ...extra,
    });
    return { exitCode, printed, progress, loaded, seen, order };
  } finally {
    console.log = stdout;
  }
}

test("--help prints the whole contract and reads nothing", async () => {
  for (const argv of [["--help"], ["-h"], []]) {
    const runResult = await run(argv);

    assert.equal(runResult.exitCode, 0, argv.join(" "));
    assert.equal(runResult.order.length, 0, `${argv.join(" ")} touches no configuration`);
    const usage = runResult.printed.join("\n");
    for (const needle of ["submit <path", "--repository", "--project <url>", "--dry-run", "--json", "FORGE_BACKLOG_TOKEN", "FORGE_BACKLOG_REPOSITORY", "FORGE_BACKLOG_PROJECT_URL", "FORGE_BACKLOG_PROJECT_ID", "Exit codes"]) {
      assert.ok(usage.includes(needle), `${needle} is documented`);
    }
  }
});

test("every command-line misuse exits 2 with usage and no configuration read", async () => {
  const cases: ReadonlyArray<readonly string[]> = [["submit"], ["submit", "x.md", "--nope"], ["submit", "x.md", "--repository"], ["submit", "x.md", "--project", "a", "--project", "b"], ["submit", "x.md", "--json", "--json"], ["tickets"], ["delete", "x.md"]];
  for (const argv of cases) {
    const result = await run(argv);

    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.ok(result.printed.join("\n").includes(argv.includes("--json") ? '"exitCode": 2' : "Usage: npm run tickets"), argv.join(" "));
    assert.equal(result.order.length, 0, `${argv.join(" ")} touches no configuration`);
  }
});

test("submit parses the flags the contract promises", () => {
  assert.deepEqual(parseTicketsArgs(["submit", "a.md", "b/*.md", "--repository", "acme/other", "--project", PROJECT_URL, "--dry-run", "--json"]), {
    paths: ["a.md", "b/*.md"],
    repository: "acme/other",
    projectUrl: PROJECT_URL,
    dryRun: true,
    json: true,
  });
  assert.deepEqual(parseTicketsArgs(["submit", "a.md"]), { paths: ["a.md"], dryRun: false, json: false });
});

test("a successful submission prints the created line, exits 0, and honours the overrides", async () => {
  const directory = await ticketDirectory();
  const backlog = new FakeBacklog({ repositoryFullName: "acme/other" });

  const result = await run(["submit", directory, "--repository", "acme/other", "--project", "https://github.com/users/octocat/projects/12"], backlog);

  assert.equal(result.exitCode, 0);
  assert.ok(result.printed.join("\n").includes(`created #100 https://github.com/acme/backlog/issues/100 T-1 ${join(directory, "first.md")} status=Ready`), result.printed.join("\n"));
  assert.ok(result.printed.join("\n").includes("totals: 1 created, 0 updated, 0 unchanged, 0 failed"));
  assert.deepEqual(JSON.parse(await readFile(join(directory, "first.submission.json"), "utf8")).backlogRepository, "acme/other");
  assert.equal(result.seen[0]?.FORGE_BACKLOG_REPOSITORY, "acme/other", "the flag overrides the environment the backlog is configured from");
  assert.equal(result.seen[0]?.FORGE_BACKLOG_PROJECT_URL, "https://github.com/users/octocat/projects/12", "the Project URL flag overrides the configured destination before resolution");
});

test("nested-only directory submission exits 2 with guidance and zero writes in both report modes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tickets-cli-nested-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "issues"));
  await writeFile(join(directory, "issues/first.md"), ticketSource("T-1"));
  const backlog = new FakeBacklog();

  for (const flags of [[], ["--json"]]) {
    const result = await run(["submit", directory, ...flags], backlog);
    assert.equal(result.exitCode, 2);
    const failure = flags.length === 0 ? result.printed.join("\n") : JSON.parse(result.printed.join("\n")).failure;
    assert.match(failure, /no top-level Markdown tickets/);
    assert.ok(failure.includes(directory));
    assert.deepEqual(backlog.writes, []);
    assert.deepEqual(backlog.reads, []);
  }

  const result = await run(["submit", join(directory, "issues")], backlog);
  assert.equal(result.exitCode, 0);
  assert.equal(backlog.issues[0]?.body, ticketSource("T-1"));
  assert.deepEqual(backlog.statusWrites, ["opt-Backlog", "opt-Ready"]);
});

test("--json prints exactly one machine-readable object", async () => {
  const directory = await ticketDirectory();

  const result = await run(["submit", directory, "--json"], new FakeBacklog());

  const report = JSON.parse(result.printed.join("\n")) as { ok: boolean; exitCode: number; entries: unknown[]; totals: Record<string, number> };
  assert.deepEqual(Object.keys(report).sort(), ["entries", "exitCode", "ok", "totals"]);
  assert.deepEqual(report.totals, { created: 1, updated: 0, unchanged: 0, failed: 0 });
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.entries.length, 1);
});

test("a dry run exits 0 and writes nothing", async () => {
  const directory = await ticketDirectory();
  const backlog = new FakeBacklog();

  const result = await run(["submit", directory, "--dry-run", "--json"], backlog);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(backlog.writes, []);
  assert.deepEqual((JSON.parse(result.printed.join("\n")) as { entries: { outcome: string }[] }).entries.map((entry) => entry.outcome), ["created"]);
});

test("a privacy gate failure exits 2, names the cause, and never prints the token", async () => {
  const directory = await ticketDirectory();

  const result = await run(["submit", directory], new FakeBacklog({ projectForbidden: true }));

  const output = result.printed.join("\n");
  assert.equal(result.exitCode, 2);
  assert.ok(output.includes("submission refused:"), output);
  assert.ok(output.includes("`project` scope"), output);
  assert.ok(!output.includes("backlog_secret_xyz") && !output.includes("gh_secret_abc"), "no credential reaches stdout");
});

test("a ticket failure exits 1 with the failing source named", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tickets-cli-"));
  await writeFile(join(directory, "bad.md"), "---\nid: T-1\nname: Broken\n---\n\n# Broken\n", "utf8");

  const result = await run(["submit", directory, "--json"], new FakeBacklog());

  assert.equal(result.exitCode, 1);
  const report = JSON.parse(result.printed.join("\n")) as { ok: boolean; entries: { outcome: string; source: string; reason?: string }[] };
  assert.equal(report.ok, false);
  assert.equal(report.entries[0]?.outcome, "failed");
  assert.ok(report.entries[0]?.source.endsWith("bad.md"));
  assert.ok((report.entries[0]?.reason ?? "").length > 0);
});

test(".env is read once, from the repository root, before the backlog is configured", async () => {
  const directory = await ticketDirectory();

  const result = await run(["submit", directory]);

  assert.deepEqual(result.order, ["loadEnvironment", "createBacklog"]);
  assert.deepEqual(result.loaded.map((path) => path.slice(path.lastIndexOf("/") + 1)), [".env"]);
});

test("a Project URL that cannot be resolved exits 2 with a redacted refusal and zero writes in both report modes", async () => {
  const directory = await ticketDirectory();
  const refusal = new BacklogConfigurationError("Backlog token cannot authorize resolving backlog Project URL: the token backlog_secret_xyz lacks the `project` scope.");
  for (const argv of [["submit", directory], ["submit", directory, "--json"]]) {
    const backlog = new FakeBacklog();

    const result = await run(argv, backlog, { createBacklog: async () => { throw refusal; } });

    const output = result.printed.join("\n");
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.ok(output.includes("resolving backlog Project URL"), output);
    assert.ok(!output.includes("backlog_secret_xyz") && !output.includes("gh_secret_abc"), "no credential reaches the report");
    assert.deepEqual(backlog.writes, [], "a refused lookup performs no backlog effect");
    if (argv.includes("--json")) {
      const report = JSON.parse(output) as { ok: boolean; exitCode: number };
      assert.deepEqual([report.ok, report.exitCode], [false, 2]);
    }
  }
});
