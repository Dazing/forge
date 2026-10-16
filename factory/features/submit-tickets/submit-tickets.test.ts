import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitProviderRegistry } from "../../infrastructure/git-provider/create-git-provider.js";
import type { GitProvider } from "../../infrastructure/git-provider/git-provider.js";
import { SubmissionGateError, submitTickets } from "./submit-tickets.js";
import { SubmissionLockError } from "./submission-state.js";
import { FakeBacklog } from "./test-backlog.js";

// Behaviour of the local submission command (plan §3 D3, AC1/AC2/AC11): batch semantics, the exact
// per-ticket effect, staging-only mutation, keyed comment idempotency, and the sidecar that records it.

const PROVIDER: GitProvider = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc" }).resolve("git@github.com:acme/api.git");

function ticketSource(id: string, name: string, options: Readonly<{ repository?: string; dependsOn?: readonly string[]; body?: string }> = {}): string {
  const dependencies = options.dependsOn ?? [];
  return [
    "---",
    `id: ${id}`,
    `name: ${name}`,
    `repository: ${options.repository ?? "git@github.com:acme/api.git"}`,
    "baseBranch: main",
    ...(dependencies.length === 0 ? [] : [`dependsOnTickets: [${dependencies.join(", ")}]`]),
    "---",
    "",
    `# ${name}`,
    "",
    options.body ?? `Requirements for ${id}.`,
    "",
  ].join("\n");
}

async function ticketDirectory(entries: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "submit-tickets-"));
  for (const [name, source] of Object.entries(entries)) {
    await writeFile(join(directory, name), source, "utf8");
  }
  return directory;
}

async function sidecar(directory: string, stem: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(directory, `${stem}.submission.json`), "utf8")) as Record<string, unknown>;
}

function submission(input: Readonly<{ paths: readonly string[]; cwd: string; backlog: FakeBacklog; dryRun?: boolean; repositoryOverride?: string; projectIdOverride?: string; now?: () => Date }>) {
  return submitTickets({
    paths: input.paths,
    backlog: input.backlog,
    provider: PROVIDER,
    cwd: input.cwd,
    dryRun: input.dryRun ?? false,
    ...(input.repositoryOverride === undefined ? {} : { repositoryOverride: input.repositoryOverride }),
    ...(input.projectIdOverride === undefined ? {} : { projectIdOverride: input.projectIdOverride }),
    json: false,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

test("a directory batch creates one issue per ticket in sorted order with verbatim bodies and Staging then Ready", async () => {
  const directory = await ticketDirectory({
    "b-second.md": ticketSource("T-2", "Second ticket", { dependsOn: ["T-1"] }),
    "a-first.md": ticketSource("T-1", "First ticket"),
  });
  const backlog = new FakeBacklog();

  const result = await submission({ paths: [directory], cwd: directory, backlog, now: () => new Date("2026-10-16T10:00:00.000Z") });

  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((entry) => [entry.ticketId, entry.outcome, entry.status]), [["T-1", "created", "Ready for development"], ["T-2", "created", "Ready for development"]]);
  assert.deepEqual(result.totals, { created: 2, updated: 0, unchanged: 0, failed: 0 });

  const created = backlog.issues;
  assert.deepEqual(created.map((issue) => issue.title), ["First ticket", "Second ticket"]);
  assert.equal(created[0]!.body, ticketSource("T-1", "First ticket"), "the issue body is the source byte for byte");
  assert.deepEqual(backlog.writeOperations().slice(0, 3), ["createIssue", "setProjectStatus", "setProjectStatus"]);
  assert.deepEqual(backlog.statusWrites, ["opt-Staging", "opt-Ready for development", "opt-Staging", "opt-Ready for development"]);
  assert.deepEqual([...new Set(backlog.statusWrites)].sort(), ["opt-Ready for development", "opt-Staging"], "submission never writes a status after Ready");
  assert.ok(!backlog.reads.includes("listProjectItems"), "submission resolves one Project item per issue, never the runner's bulk walk");

  const record = await sidecar(directory, "a-first");
  assert.deepEqual(Object.keys(record).sort(), ["backlogRepository", "issueNodeId", "issueNumber", "issueUrl", "lastComment", "projectId", "requirementsHash", "sourceHash", "submittedAt", "version"]);
  assert.equal(record.version, 1);
  assert.equal(record.backlogRepository, "acme/backlog");
  assert.equal(record.projectId, "PVT_project_1");
  assert.equal(record.submittedAt, "2026-10-16T10:00:00.000Z");
  assert.match(String((record.lastComment as Record<string, unknown>).marker), /^<!-- factory:comment:T-1:[0-9a-f]{12} -->$/);
});

test("a rerun with unchanged content performs zero writes and posts no comment", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const backlog = new FakeBacklog();
  await submission({ paths: [directory], cwd: directory, backlog });
  const writesAfterFirst = backlog.writes.length;
  const commentsAfterFirst = backlog.commentsFor(100).length;

  const result = await submission({ paths: [directory], cwd: directory, backlog });

  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map((entry) => entry.outcome), ["unchanged"]);
  assert.equal(result.entries[0]!.issueNumber, 100);
  assert.equal(backlog.writes.length, writesAfterFirst, "an unchanged ticket writes nothing");
  assert.equal(backlog.commentsFor(100).length, commentsAfterFirst);
});

test("a changed source returned to Staging updates the body with the read revision and posts exactly one new keyed comment", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const backlog = new FakeBacklog();
  await submission({ paths: [directory], cwd: directory, backlog });
  const firstMarker = String(((await sidecar(directory, "first")).lastComment as Record<string, unknown>).marker);
  await backlog.setProjectStatus(backlog.issues[0]!.nodeId, "opt-Staging");

  await writeFile(join(directory, "first.md"), ticketSource("T-1", "First ticket", { body: "Requirements for T-1, revised." }), "utf8");
  const result = await submission({ paths: [directory], cwd: directory, backlog });

  assert.deepEqual(result.entries.map((entry) => entry.outcome), ["updated"]);
  const updates = backlog.writes.filter((write) => write.operation === "updateIssueBody");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.body, ticketSource("T-1", "First ticket", { body: "Requirements for T-1, revised." }));
  const comments = backlog.commentsFor(100);
  assert.equal(comments.length, 2, "one comment per distinct content hash");
  assert.ok(comments[0]!.body.includes(firstMarker));
  assert.ok(comments[1]!.body.includes("<!-- factory:comment:T-1:"), "the new comment carries the operation-key marker");
  assert.deepEqual(backlog.statusWrites.slice(3), ["opt-Staging", "opt-Ready for development"], "a resubmission re-stages, then returns the ticket to Ready");
});

test("a rerun whose content is unchanged after a successful update posts no comment", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket", { body: "Revised." }) });
  const backlog = new FakeBacklog();
  await submission({ paths: [directory], cwd: directory, backlog });
  await submission({ paths: [directory], cwd: directory, backlog });

  assert.equal(backlog.commentsFor(100).length, 1);
  assert.equal(backlog.writes.filter((write) => write.operation === "createComment").length, 1);
});

test("an existing comment with the same operation-key marker is never duplicated", async () => {
  const directory = await ticketDirectory({});
  const source = ticketSource("T-1", "First ticket");
  const marker = `<!-- factory:comment:T-1:${createHash("sha256").update(source).digest("hex").slice(0, 12)} -->`;
  const backlog = new FakeBacklog();
  backlog.seedIssue(source, { number: 100, status: "Staging" });
  backlog.seedComment(100, `${marker}\n- Ticket: T-1`, 700);
  await writeFile(join(directory, "first.md"), source, "utf8");

  const result = await submission({ paths: [join(directory, "first.md")], cwd: directory, backlog });

  assert.equal(result.entries[0]!.outcome, "updated", "no sidecar means the ticket is submitted again");
  assert.equal(backlog.commentsFor(100).length, 1, "the keyed comment is recognised and not reposted");
  const record = await sidecar(directory, "first");
  assert.equal((record.lastComment as Record<string, unknown>).marker, marker);
  assert.equal((record.lastComment as Record<string, unknown>).url, "https://github.com/acme/backlog/issues/100#issuecomment-700");
});

test("a public backlog repository stops the run before any write", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const backlog = new FakeBacklog({ repositoryPrivate: false });

  await assert.rejects(() => submission({ paths: [directory], cwd: directory, backlog }), SubmissionGateError);
  assert.deepEqual(backlog.writes, []);
});

test("a public Project stops the run before any write", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const backlog = new FakeBacklog({ projectPublic: true });

  await assert.rejects(() => submission({ paths: [directory], cwd: directory, backlog }), (error: unknown) => error instanceof SubmissionGateError && /public/.test(error.message));
  assert.deepEqual(backlog.writes, []);
});

test("a Project the token cannot read is diagnosed as a missing project scope without the token", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const backlog = new FakeBacklog({ projectForbidden: true });

  const error = await submission({ paths: [directory], cwd: directory, backlog }).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof SubmissionGateError);
  assert.match(error.message, /`project` scope/);
  assert.ok(!error.message.includes("backlog_secret_xyz"), "the backlog token never reaches a report");
  assert.deepEqual(backlog.writes, []);
});

test("a Project the token cannot update is a configuration failure with zero writes", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const backlog = new FakeBacklog({ projectReadOnly: true });

  await assert.rejects(
    () => submission({ paths: [directory], cwd: directory, backlog }),
    (error: unknown) => error instanceof SubmissionGateError && /not updatable/.test(error.message),
  );
  assert.deepEqual(backlog.writes, []);
});

test("a Project without the configured Status options is a configuration failure", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const missingOptions = new FakeBacklog({ projectStatuses: ["Staging"] });
  const noField = new FakeBacklog({ projectStatusField: false });

  await assert.rejects(() => submission({ paths: [directory], cwd: directory, backlog: missingOptions }), /missing required options/);
  await assert.rejects(() => submission({ paths: [directory], cwd: directory, backlog: noField }), /no single-select/);
  assert.deepEqual(missingOptions.writes, []);
  assert.deepEqual(noField.writes, []);
});

test("a backlog repository that is not the configured one stops the run", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const backlog = new FakeBacklog({ repositoryFullName: "acme/other" });

  await assert.rejects(() => submission({ paths: [directory], cwd: directory, backlog }), /mismatch/);
  assert.deepEqual(backlog.writes, []);
});

test("a self-dependency, a duplicate ID, an unknown dependency, and a cycle each fail the batch with zero writes", async () => {
  const selfDirectory = await ticketDirectory({ "self.md": ticketSource("T-1", "Self", { dependsOn: ["T-1"] }) });
  const duplicateDirectory = await ticketDirectory({ "a.md": ticketSource("T-1", "A"), "b.md": ticketSource("T-1", "B") });
  const unknownDirectory = await ticketDirectory({ "b.md": ticketSource("T-2", "B", { dependsOn: ["T-9"] }) });
  const cycleDirectory = await ticketDirectory({
    "a.md": ticketSource("T-1", "A", { dependsOn: ["T-2"] }),
    "b.md": ticketSource("T-2", "B", { dependsOn: ["T-1"] }),
  });

  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [selfDirectory, "itself", "T-1"],
    [duplicateDirectory, "unique per backlog repository", "T-1"],
    [unknownDirectory, "neither this batch nor the backlog", "T-9"],
    [cycleDirectory, "Dependency cycle", "T-1"],
  ];
  for (const [directory, expectation] of cases) {
    const backlog = new FakeBacklog();
    const result = await submission({ paths: [directory], cwd: directory, backlog });

    assert.equal(result.ok, false, expectation);
    assert.ok(result.entries.every((entry) => entry.outcome === "failed"), expectation);
    assert.match(result.entries.map((entry) => entry.reason).join("\n"), new RegExp(expectation));
    assert.deepEqual(backlog.writes, [], `${expectation} writes nothing`);
  }
});

test("a dependency that already exists in the backlog resolves and a repository the provider rejects does not", async () => {
  const directory = await ticketDirectory({
    "dependent.md": ticketSource("T-2", "Dependent", { dependsOn: ["T-1"] }),
    "ado.md": ticketSource("T-3", "Azure ticket", { repository: "git@ssh.dev.azure.com:v3/org/proj/repo" }),
  });
  const backlog = new FakeBacklog();
  backlog.seedIssue(ticketSource("T-1", "Already submitted"), { number: 60, status: "Done" });

  const result = await submission({ paths: [directory], cwd: directory, backlog });

  assert.equal(result.ok, false);
  assert.deepEqual(result.entries.map((entry) => entry.source.slice(directory.length + 1)), ["ado.md"]);
  assert.match(result.entries[0]!.reason ?? "", /Repository must be a git@github\.com:<owner>\/<repository>\.git SSH URL/);
  assert.deepEqual(backlog.writes, [], "one invalid ticket fails the whole batch with zero writes");
});

test("a sidecar with an unrecognised field fails that ticket and names the sidecar path", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const backlog = new FakeBacklog();
  await submission({ paths: [directory], cwd: directory, backlog });
  const sidecarPath = join(directory, "first.submission.json");
  const record = { ...(JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>), extraField: "surprise" };
  await writeFile(sidecarPath, JSON.stringify(record), "utf8");
  await writeFile(join(directory, "first.md"), ticketSource("T-1", "First ticket", { body: "Changed." }), "utf8");

  const result = await submission({ paths: [directory], cwd: directory, backlog });

  assert.equal(result.ok, false);
  assert.equal(result.entries[0]!.outcome, "failed");
  assert.match(result.entries[0]!.reason ?? "", /first\.submission\.json/);
  assert.match(result.entries[0]!.reason ?? "", /unrecognised/);
  assert.equal(backlog.writes.filter((write) => write.operation === "updateIssueBody").length, 0, "a broken sidecar is never silently rewritten");
  assert.equal(JSON.parse(await readFile(sidecarPath, "utf8")).extraField, "surprise");
});

test("a sidecar whose version is not 1 fails that ticket", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  await writeFile(join(directory, "first.submission.json"), JSON.stringify({ version: 2 }), "utf8");
  const backlog = new FakeBacklog();

  const result = await submission({ paths: [directory], cwd: directory, backlog });

  assert.equal(result.entries[0]!.outcome, "failed");
  assert.match(result.entries[0]!.reason ?? "", /first\.submission\.json/);
  assert.deepEqual(backlog.writes.filter((write) => write.operation === "createIssue"), []);
});

test("a dry run reports the exact plan with zero write calls", async () => {
  const directory = await ticketDirectory({
    "new.md": ticketSource("T-2", "New ticket"),
    "changed.md": ticketSource("T-1", "First ticket", { body: "Changed requirements." }),
  });
  const backlog = new FakeBacklog();
  backlog.seedIssue(ticketSource("T-1", "First ticket"), { number: 70, status: "Staging" });

  const result = await submission({ paths: [directory], cwd: directory, backlog, dryRun: true });

  assert.deepEqual(result.entries.map((entry) => [entry.ticketId, entry.outcome]), [["T-1", "updated"], ["T-2", "created"]]);
  assert.equal(result.entries.find((entry) => entry.ticketId === "T-1")!.issueNumber, 70);
  assert.deepEqual(backlog.writes, [], "the transport never receives a write call in a dry run");
  assert.ok(backlog.reads.includes("validateRepository") && backlog.reads.includes("validateProject"), "every gate still runs");
});

test("a second submission refuses to run while the batch lock is held", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  await writeFile(join(directory, ".sandcastle-submission.lock"), JSON.stringify({ pid: 4242, startedAt: "2026-10-16T09:00:00.000Z" }), "utf8");
  const backlog = new FakeBacklog();

  const error = await submission({ paths: [directory], cwd: directory, backlog }).then(() => undefined, (caught: unknown) => caught);

  assert.ok(error instanceof SubmissionLockError);
  assert.match(error.message, /\.sandcastle-submission\.lock/);
  assert.match(error.message, /4242/);
  assert.deepEqual(backlog.reads, [], "the backlog is not touched while the lock is held");
  const lock = JSON.parse(await readFile(join(directory, ".sandcastle-submission.lock"), "utf8")) as { pid: number };
  assert.equal(lock.pid, 4242, "a live lock is never auto-removed");
});

test("the batch lock is released after a successful run and after a ticket failure", async () => {
  const good = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const broken = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket"), "first.submission.json": JSON.stringify({ version: 2 }) });

  await submission({ paths: [good], cwd: good, backlog: new FakeBacklog() });
  await submission({ paths: [broken], cwd: broken, backlog: new FakeBacklog() });

  for (const directory of [good, broken]) {
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".lock")), [], `the lock is released in ${directory}`);
  }
});

test("an issue outside Staging refuses mutation and reports the ticket failure with zero writes", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket", { body: "Revised after the claim." }) });
  const backlog = new FakeBacklog();
  backlog.seedIssue(ticketSource("T-1", "First ticket"), { number: 71, status: "In progress" });

  const result = await submission({ paths: [directory], cwd: directory, backlog });

  assert.equal(result.ok, false);
  assert.equal(result.entries[0]!.outcome, "failed");
  assert.match(result.entries[0]!.reason ?? "", /only `Staging` accepts a resubmission/);
  assert.deepEqual(backlog.writes, [], "a claimed ticket is never mutated and its Project item is never moved");
});

test("an issue edited externally mid-flight is reported as a conflict and never overwritten blindly", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket", { body: "Local revision." }) });
  const backlog = new FakeBacklog({ externalEditBeforeUpdate: (issue) => { issue.revision = "externally-bumped"; } });
  backlog.seedIssue(ticketSource("T-1", "First ticket"), { number: 72, status: "Staging" });

  const result = await submission({ paths: [directory], cwd: directory, backlog });

  assert.equal(result.entries[0]!.outcome, "failed");
  assert.match(result.entries[0]!.reason ?? "", /changed externally/);
  assert.equal(backlog.issues.find((issue) => issue.number === 72)!.body, ticketSource("T-1", "First ticket"));
  assert.deepEqual(backlog.statusWrites, [], "the Project item is not moved when the body update is refused");
});

test("a comment failure redacts the token and keeps the accepted work recoverable", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const backlog = new FakeBacklog({ commentFailure: "GitHub returned HTTP 500 with Bearer backlog_secret_xyz" });

  const result = await submission({ paths: [directory], cwd: directory, backlog });

  assert.equal(result.entries[0]!.outcome, "failed");
  assert.match(result.entries[0]!.reason ?? "", /HTTP 500/);
  assert.ok(!(result.entries[0]!.reason ?? "").includes("backlog_secret_xyz"), "transport diagnostics are redacted");
  await assert.rejects(() => sidecar(directory, "first"), "the sidecar is written last, so the run replays from the read-back");
});

test("an accepted ticket keeps its sidecar when a later ticket is refused", async () => {
  const directory = await ticketDirectory({
    "a-first.md": ticketSource("T-1", "First ticket"),
    "b-second.md": ticketSource("T-2", "Second ticket"),
  });
  const backlog = new FakeBacklog();
  backlog.seedIssue(ticketSource("T-2", "Second ticket"), { number: 80, status: "In progress" });

  const result = await submission({ paths: [directory], cwd: directory, backlog });

  assert.equal(result.ok, false);
  assert.deepEqual(result.entries.map((entry) => [entry.ticketId, entry.outcome]), [["T-1", "created"], ["T-2", "failed"]]);
  assert.equal((await sidecar(directory, "a-first")).issueNumber, 100, "the accepted ticket is recorded before the refusal");
  await assert.rejects(() => readFile(join(directory, "b-second.submission.json"), "utf8"), "a refused ticket records no sidecar");
});

test("--repository retargets validation and is recorded in the sidecar", async () => {
  const directory = await ticketDirectory({ "first.md": ticketSource("T-1", "First ticket") });
  const backlog = new FakeBacklog({ repositoryFullName: "acme/other" });

  const result = await submission({ paths: [directory], cwd: directory, backlog, repositoryOverride: "acme/other" });

  assert.equal(result.ok, true);
  assert.equal((await sidecar(directory, "first")).backlogRepository, "acme/other");
});


