import { appendFile, link, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import Ajv from "ajv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAME = "submit_handoff";
const MAX_CONTROL_BYTES = 64 * 1024;
const controlDir = process.env.FACTORY_HANDOFF_CONTROL_DIR;

function fail(message) {
  throw new Error(`Handoff server startup failed: ${message}`);
}

async function recordEvent(event) {
  await appendFile(join(controlDir, "result", "events.log"), `${event}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readContract() {
  if (!controlDir) fail("FACTORY_HANDOFF_CONTROL_DIR is not set");
  const path = join(controlDir, "contract.json");
  const details = await stat(path);
  if (!details.isFile() || details.size === 0 || details.size > MAX_CONTROL_BYTES) fail("contract size is invalid");
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("contract is not valid JSON");
  }
  if (value?.version !== 1 || value.toolName !== TOOL_NAME || typeof value.nonce !== "string" || value.nonce.length < 8 || value.nonce.length > 200 || typeof value.description !== "string" || value.description.length === 0 || typeof value.inputSchema !== "object" || value.inputSchema === null || Array.isArray(value.inputSchema)) {
    fail("contract fields are invalid");
  }
  return value;
}

function validationMessage(errors) {
  return errors.map((error) => {
    const path = error.instancePath || "$";
    if (error.keyword === "required") return `${path}: missing required field ${error.params.missingProperty}`;
    if (error.keyword === "additionalProperties") return `${path}: unexpected field ${error.params.additionalProperty}`;
    return `${path}: ${error.message ?? `failed ${error.keyword}`}`;
  }).join("; ");
}

async function publishResult(contract, payload) {
  const envelope = JSON.stringify({ version: 1, nonce: contract.nonce, toolName: TOOL_NAME, payload });
  if (Buffer.byteLength(envelope) > MAX_CONTROL_BYTES) return "oversized";
  const resultPath = join(controlDir, "result", "result.json");
  const temporaryPath = join(controlDir, "result", `.result-${process.pid}-${crypto.randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(envelope, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporaryPath, resultPath);
    return "accepted";
  } catch (error) {
    if (error?.code === "EEXIST") return "duplicate";
    throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function main() {
  const contract = await readContract();
  const ajv = new Ajv({ allErrors: true, strict: true });
  let validate;
  try {
    validate = ajv.compile(contract.inputSchema);
  } catch {
    fail("input schema is invalid");
  }

  const server = new Server(
    { name: "factory-handoff", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: "Call submit_handoff once after all stage obligations pass." },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: TOOL_NAME, description: contract.description, inputSchema: contract.inputSchema }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      await recordEvent("rejected unknown tool");
      return { isError: true, content: [{ type: "text", text: "Unknown tool. Only submit_handoff is available." }] };
    }
    const payload = request.params.arguments ?? {};
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_CONTROL_BYTES) {
      await recordEvent("rejected argument size");
      return { isError: true, content: [{ type: "text", text: "Handoff arguments exceed the size limit." }] };
    }
    if (!validate(payload)) {
      await recordEvent("rejected schema validation");
      return { isError: true, content: [{ type: "text", text: `Handoff validation failed: ${validationMessage(validate.errors ?? [])}` }] };
    }
    const publication = await publishResult(contract, payload);
    if (publication === "oversized") {
      await recordEvent("rejected result size");
      return { isError: true, content: [{ type: "text", text: "Handoff result exceeds the size limit." }] };
    }
    if (publication === "duplicate") {
      await recordEvent("rejected duplicate");
      return { isError: true, content: [{ type: "text", text: "A handoff was already accepted; the first valid result is immutable." }] };
    }
    await recordEvent("accepted");
    return { content: [{ type: "text", text: "Handoff accepted. Stop now without running more tools or changing files." }] };
  });

  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_CONTROL_BYTES }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Handoff server startup failed.");
  process.exitCode = 1;
});
