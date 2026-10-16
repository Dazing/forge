import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicationLedger, STATE_DIRECTORY } from "./publication-ledger.js";
import type { PublicationIntent, PublicationResult } from "./publication-record.js";

const intent: PublicationIntent = {
  version: 1,
  operationKey: "factory:publication:ticket-a:1a2b3c",
  groupId: "group-1",
  provider: "github",
  repository: "acme/app",
  baseBranch: "main",
  baseSha: "0".repeat(40),
  head: "factory/ticket-a",
  sourceSha: "1".repeat(40),
  title: "Fix login redirect",
  body: "Body",
  mergeStrategy: "squash",
  included: [{ ticketId: "ticket-a", issueNumber: 7, issueNodeId: "I_kwDO1234", requirementsHash: "a".repeat(64) }],
  recordedAt: "2026-10-11T07:00:00.000Z",
};

const result: PublicationResult = {
  ...intent,
  pullRequestNumber: 123,
  pullRequestUrl: "https://github.com/acme/app/pull/123",
  squashPreference: "unsupported",
  publishedAt: "2026-10-11T07:01:00.000Z",
};

const settlement = {
  version: 1 as const,
  operationKey: "factory:settlement:issue-7:status-in-review",
  kind: "status" as const,
  subject: "issue-7",
  status: "In review" as const,
  ticketId: "ticket-a",
  issueNumber: 7,
  issueNodeId: "I_kwDO1234",
  detail: "pull-request-123",
  recordedAt: "2026-10-11T07:02:00.000Z",
};

const INTENT_NAME = "publication-intent-factory:publication:ticket-z:99.json";

async function openLedger(): Promise<{ state: string; ledger: PublicationLedger }> {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-ledger-"));
  const state = join(root, STATE_DIRECTORY);
  await mkdir(state);
  return { state, ledger: PublicationLedger.open(root) };
}

test("intents, results, and pending settlements round-trip through a reopened state directory", async () => {
  const { ledger } = await openLedger();
  await ledger.writeIntent(intent);
  await ledger.writeResult(result);
  await ledger.recordSettlement(settlement);

  const reopened = PublicationLedger.open(join(ledger.directory, ".."));
  const snapshot = await reopened.load();
  assert.deepEqual(snapshot.intents, [intent]);
  assert.deepEqual(snapshot.results, [result]);
  assert.deepEqual(snapshot.settlements, [settlement]);
  assert.deepEqual(snapshot.corrupt, []);
});

test("an unrecognised record file is reported as corrupt and never silently skipped", async () => {
  const { state, ledger } = await openLedger();
  await ledger.writeIntent(intent);
  await writeFile(join(state, "mystery-1.json"), JSON.stringify({ version: 1 }));
  await writeFile(join(state, "publication-result-not-a-key.json"), "{not json");
  const snapshot = await ledger.load();
  assert.deepEqual(snapshot.intents, [intent]);
  assert.equal(snapshot.corrupt.length, 2);
  assert.deepEqual(snapshot.corrupt.map((record) => record.file).sort(), ["mystery-1.json", "publication-result-not-a-key.json"]);
});

test("a settlement with an unrecognised field is corrupt, including one carrying a credential", async () => {
  const { state, ledger } = await openLedger();
  await writeFile(join(state, "settlement-factory:settlement:ticket-a:1a2b3c.json"), JSON.stringify({ ...settlement, token: "ghp_leaked" }));
  const snapshot = await ledger.load();
  assert.deepEqual(snapshot.settlements, []);
  assert.equal(snapshot.corrupt.length, 1);
  assert.match(snapshot.corrupt[0]!.reason, /token/);
});

test("a completed settlement disappears so a restart never replays it", async () => {
  const { ledger } = await openLedger();
  await ledger.recordSettlement(settlement);
  assert.deepEqual((await ledger.load()).settlements, [settlement]);
  await ledger.completeSettlement(settlement.operationKey);
  const snapshot = await ledger.load();
  assert.deepEqual(snapshot.settlements, []);
  assert.deepEqual(snapshot.corrupt, []);
});

test("a crashed write leaves the prior record readable and the temp file unread", async () => {
  const { state, ledger } = await openLedger();
  await ledger.writeIntent(intent);
  await writeFile(join(state, `${INTENT_NAME}.4242.tmp`), "{\"partial\":");
  const snapshot = await ledger.load();
  assert.deepEqual(snapshot.intents, [intent]);
  assert.deepEqual(snapshot.corrupt, []);
});

test("persisted records carry the facts a restart needs and no credential material", async () => {
  const { state, ledger } = await openLedger();
  await ledger.writeIntent(intent);
  await ledger.writeResult(result);
  await ledger.recordSettlement(settlement);
  const names = (await readdir(state)).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, [
    INTENT_NAME.replace("ticket-z:99", "ticket-a:1a2b3c"),
    "publication-result-factory:publication:ticket-a:1a2b3c.json",
    "settlement-factory:settlement:issue-7:status-in-review.json",
  ]);
  const text = (await Promise.all(names.map((name) => readFile(join(state, name), "utf8")))).join("\n");
  assert.match(text, /"sourceSha": "1{40}"/);
  assert.match(text, /"requirementsHash": "a{64}"/);
  assert.match(text, /"pullRequestNumber": 123/);
  for (const secret of ["ghp_", "ghu_", "AZURE_DEVOPS_PAT", "Authorization", "Bearer", "Basic"]) {
    assert.ok(!text.includes(secret), `the ledger persisted ${secret}`);
  }
});

test("an unsafe record key is rejected before any file is written", async () => {
  const { state, ledger } = await openLedger();
  assert.throws(
    () => ledger.writeIntent({ ...intent, operationKey: "../../escape" }),
    /not a runner operation key/,
  );
  assert.deepEqual((await readdir(state)).filter((name) => name.startsWith("publication-intent-")), []);
});
