import { appendFile } from "node:fs/promises";
import { run as sandcastleRun, type RunResult } from "@ai-hero/sandcastle";
import { ticketAgent } from "./create-agent.js";
import { createHandoffChannel } from "./handoff-channel.js";
import {
  AgentHandoffTransportError,
  AgentHandoffValidationError,
  type AgentHandoffDefinition,
  MissingAgentHandoffError,
} from "./handoff.js";
import { sandboxProvider, type AgentHarness } from "../sandbox/sandbox.js";
import type { InvocationLogger } from "../logging/invocation-log.js";

// Generic configured agent execution. Features own handoff schemas and stage completion policy;
// infrastructure owns the isolated transport and configured sandbox lifecycle.

async function appendHandoffStatus(logPath: string, statuses: readonly string[]): Promise<void> {
  if (statuses.length === 0) return;
  await appendFile(logPath, `${statuses.map((status) => `Handoff: ${status}`).join("\n")}\n`).catch(() => undefined);
}
export interface AgentRunRequest<THandoff> {
  cwd: string;
  harness: AgentHarness;
  name: string;
  logName: string;
  promptFile: string;
  promptArgs: Record<string, string>;
  handoff: AgentHandoffDefinition<THandoff>;
  maxIterations?: number;
}

export interface AgentRunResult<THandoff> extends RunResult {
  handoff: THandoff;
}

export type AgentRunner = <THandoff>(request: AgentRunRequest<THandoff>) => Promise<AgentRunResult<THandoff>>;

export function createAgentRunner(logger: InvocationLogger, factoryRoot: string): AgentRunner {
  return async <THandoff>(request: AgentRunRequest<THandoff>): Promise<AgentRunResult<THandoff>> => {
    const channel = await createHandoffChannel(request.handoff);
    const logPath = logger.agentLogPath(request.logName);
    let runFinished = false;
    try {
      const result = await sandcastleRun({
        cwd: request.cwd,
        sandbox: sandboxProvider(request.harness, factoryRoot, request.cwd, {
          contractPath: channel.contractPath,
          resultDirectoryPath: channel.resultDirectoryPath,
        }),
        branchStrategy: { type: "head" as const },
        name: request.name,
        agent: ticketAgent(request.harness),
        logging: { type: "file" as const, path: logPath },
        promptFile: request.promptFile,
        promptArgs: request.promptArgs,
        ...(request.maxIterations === undefined ? {} : { maxIterations: request.maxIterations }),
      });
      runFinished = true;
      const events = await channel.readEvents();
      await appendHandoffStatus(logPath, events);
      try {
        const handoff = await channel.consume();
        await appendHandoffStatus(logPath, ["accepted by host"]);
        return { ...result, handoff };
      } catch (error) {
        const status = error instanceof MissingAgentHandoffError
          ? "omitted"
          : error instanceof AgentHandoffValidationError
            ? "rejected by host validation"
            : error instanceof AgentHandoffTransportError
              ? "transport failure"
              : "host failure";
        await appendHandoffStatus(logPath, [status]);
        throw error;
      }
    } catch (error) {
      if (!runFinished) await appendHandoffStatus(logPath, ["transport failure"]);
      throw error;
    } finally {
      await channel.dispose();
    }
  };
}
