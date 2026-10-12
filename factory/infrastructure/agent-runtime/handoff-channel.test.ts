import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { z } from "zod";
import { createAgentHandoff } from "./handoff.js";
import { createHandoffChannel } from "./handoff-channel.js";

test("control channel authenticates, validates, and cleans an isolated result", async () => {
  const definition = createAgentHandoff("Submit result.", z.strictObject({ message: z.string().min(1) }));
  const channel = await createHandoffChannel(definition);
  const contract = JSON.parse(await readFile(channel.contractPath, "utf8")) as { nonce: string };
  assert.match(contract.nonce, /^[0-9a-f-]{36}$/);

  await writeFile(channel.resultPath, JSON.stringify({
    version: 1,
    nonce: contract.nonce,
    toolName: "submit_handoff",
    payload: { message: "accepted" },
  }));
  assert.deepEqual(await channel.consume(), { message: "accepted" });

  await channel.dispose();
  await assert.rejects(access(channel.hostPath), { code: "ENOENT" });
});

test("control channel rejects stale and missing results", async () => {
  const definition = createAgentHandoff("Submit result.", z.strictObject({ message: z.string() }));
  const missing = await createHandoffChannel(definition);
  await assert.rejects(missing.consume(), { name: "MissingAgentHandoffError" });
  await missing.dispose();

  const stale = await createHandoffChannel(definition);
  await writeFile(stale.resultPath, JSON.stringify({ version: 1, nonce: "stale-nonce", toolName: "submit_handoff", payload: { message: "wrong" } }));
  await assert.rejects(stale.consume(), /nonce/i);
  await stale.dispose();
});

test("control channel rejects malformed and oversized artifacts without exposing payloads", async () => {
  const definition = createAgentHandoff("Submit result.", z.strictObject({ message: z.string() }));
  const malformed = await createHandoffChannel(definition);
  await writeFile(malformed.resultPath, "{partial-secret");
  await assert.rejects(malformed.consume(), /not valid JSON/);
  await malformed.dispose();

  const oversized = await createHandoffChannel(definition);
  await writeFile(oversized.resultPath, "x".repeat(64 * 1024 + 1));
  await assert.rejects(oversized.consume(), /invalid size/);
  await oversized.dispose();
});

test("concurrent control channels cannot cross-consume results", async () => {
  const definition = createAgentHandoff("Submit result.", z.strictObject({ message: z.string() }));
  const [first, second] = await Promise.all([createHandoffChannel(definition), createHandoffChannel(definition)]);
  const [firstContract, secondContract] = await Promise.all([
    readFile(first.contractPath, "utf8").then((value) => JSON.parse(value) as { nonce: string }),
    readFile(second.contractPath, "utf8").then((value) => JSON.parse(value) as { nonce: string }),
  ]);
  assert.notEqual(first.hostPath, second.hostPath);
  assert.notEqual(firstContract.nonce, secondContract.nonce);

  await Promise.all([
    writeFile(first.resultPath, JSON.stringify({ version: 1, nonce: firstContract.nonce, toolName: "submit_handoff", payload: { message: "first" } })),
    writeFile(second.resultPath, JSON.stringify({ version: 1, nonce: secondContract.nonce, toolName: "submit_handoff", payload: { message: "second" } })),
  ]);

  assert.deepEqual(await Promise.all([first.consume(), second.consume()]), [{ message: "first" }, { message: "second" }]);
  await Promise.all([first.dispose(), second.dispose()]);
});
