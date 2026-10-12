import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentHandoffTransportError,
  MissingAgentHandoffError,
  type AgentHandoffDefinition,
  HANDOFF_TOOL_NAME,
} from "./handoff.js";

const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 8 * 1024;
const SAFE_EVENTS: Readonly<Record<string, true>> = {
  "rejected unknown tool": true,
  "rejected argument size": true,
  "rejected schema validation": true,
  "rejected result size": true,
  "rejected duplicate": true,
  accepted: true,
};

export interface HandoffChannel<T> {
  readonly hostPath: string;
  readonly contractPath: string;
  readonly resultDirectoryPath: string;
  readonly resultPath: string;
  consume(): Promise<T>;
  readEvents(): Promise<readonly string[]>;
  dispose(): Promise<void>;
}

export async function createHandoffChannel<T>(definition: AgentHandoffDefinition<T>): Promise<HandoffChannel<T>> {
  const hostPath = await mkdtemp(join(tmpdir(), "factory-handoff-"));
  const contractPath = join(hostPath, "contract.json");
  const resultDirectoryPath = join(hostPath, "result");
  const resultPath = join(resultDirectoryPath, "result.json");
  const eventsPath = join(resultDirectoryPath, "events.log");
  const nonce = randomUUID();
  await mkdir(resultDirectoryPath, { mode: 0o700 });
  await writeFile(contractPath, JSON.stringify({
    version: 1,
    nonce,
    toolName: definition.toolName,
    description: definition.description,
    inputSchema: definition.inputSchema,
  }), { mode: 0o600 });
  await chmod(contractPath, 0o400);

  return {
    hostPath,
    contractPath,
    resultDirectoryPath,
    resultPath,
    async readEvents(): Promise<readonly string[]> {
      try {
        const details = await stat(eventsPath);
        if (!details.isFile() || details.size > MAX_EVENT_BYTES) return ["transport failure"];
        return (await readFile(eventsPath, "utf8"))
          .split("\n")
          .filter((event) => SAFE_EVENTS[event] === true);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : ["transport failure"];
      }
    },
    async consume(): Promise<T> {
      let details;
      try {
        details = await stat(resultPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingAgentHandoffError();
        throw new AgentHandoffTransportError("Unable to inspect the agent handoff result.", { cause: error });
      }
      if (!details.isFile() || details.size === 0 || details.size > MAX_CONTROL_BYTES) {
        throw new AgentHandoffTransportError("Agent handoff result has an invalid size.");
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(await readFile(resultPath, "utf8"));
      } catch (error) {
        throw new AgentHandoffTransportError("Agent handoff result is not valid JSON.", { cause: error });
      }
      if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
        throw new AgentHandoffTransportError("Agent handoff result envelope is invalid.");
      }
      const fields = envelope as Record<string, unknown>;
      if (fields.version !== 1 || fields.nonce !== nonce || fields.toolName !== HANDOFF_TOOL_NAME) {
        throw new AgentHandoffTransportError("Agent handoff result has an invalid nonce or tool identity.");
      }
      return definition.validate(fields.payload);
    },
    async dispose(): Promise<void> {
      await rm(hostPath, { recursive: true, force: true });
    },
  };
}
