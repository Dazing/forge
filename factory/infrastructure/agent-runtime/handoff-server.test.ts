import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = resolve(import.meta.dirname, "handoff-server.mjs");

test("MCP server publishes only the first valid submit_handoff payload", async () => {
  const controlDir = await mkdtemp(join(tmpdir(), "handoff-server-test-"));
  const contract = {
    version: 1,
    nonce: "nonce-123",
    toolName: "submit_handoff",
    description: "Submit a result.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", minLength: 1, maxLength: 20 } },
      required: ["message"],
      additionalProperties: false,
    },
  };
  const contractPath = join(controlDir, "contract.json");
  await writeFile(contractPath, JSON.stringify(contract), { mode: 0o600 });
  await chmod(contractPath, 0o400);
  await mkdir(join(controlDir, "result"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, FACTORY_HANDOFF_CONTROL_DIR: controlDir } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "handoff-test", version: "1" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    assert.equal(listed.tools[0]?.name, "submit_handoff");
    assert.deepEqual(listed.tools[0]?.inputSchema, contract.inputSchema);

    const invalid = await client.callTool({ name: "submit_handoff", arguments: { message: "", secret: "must-not-echo" } });
    assert.equal(invalid.isError, true);
    await assert.rejects(readFile(join(controlDir, "result", "result.json"), "utf8"), { code: "ENOENT" });

    const accepted = await client.callTool({ name: "submit_handoff", arguments: { message: "complete" } });
    assert.equal(accepted.isError, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(controlDir, "result", "result.json"), "utf8")), {
      version: 1,
      nonce: "nonce-123",
      toolName: "submit_handoff",
      payload: { message: "complete" },
    });

    const duplicate = await client.callTool({ name: "submit_handoff", arguments: { message: "replacement" } });
    assert.equal(duplicate.isError, true);
    assert.match(JSON.stringify(duplicate), /already accepted/i);
    assert.doesNotMatch(JSON.stringify(duplicate), /replacement/);
    assert.equal(await readFile(join(controlDir, "result", "events.log"), "utf8"), [
      "rejected schema validation",
      "accepted",
      "rejected duplicate",
      "",
    ].join("\n"));
  } finally {
    await client.close();
  }
});

test("MCP server fails closed on a malformed bounded contract", async () => {
  const controlDir = await mkdtemp(join(tmpdir(), "handoff-server-invalid-"));
  await writeFile(join(controlDir, "contract.json"), "{credential-like-content");
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, FACTORY_HANDOFF_CONTROL_DIR: controlDir },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const [exitCode] = await once(child, "close") as [number];

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /contract is not valid JSON/);
  assert.doesNotMatch(stderr, /credential-like-content/);
});
