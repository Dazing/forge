import { run as sandcastleRun, type OutputObjectDefinition, type RunResult } from "@ai-hero/sandcastle";
import { ticketAgent } from "./create-agent.js";
import { sandboxProvider, type AgentHarness } from "../sandbox/sandbox.js";
import type { InvocationLogger } from "../logging/invocation-log.js";

// Generic configured agent execution: sandbox provider, file logging, prompt file, completion
// signal, structured output, and iteration limits. Stage prompts and completion enforcement
// stay with the owning features.


export interface AgentRunRequest<TOutput = undefined> {
  cwd: string;
  harness: AgentHarness;
  name: string;
  logName: string;
  promptFile: string;
  promptArgs: Record<string, string>;
  completionSignal?: string;
  output?: OutputObjectDefinition<TOutput>;
  maxIterations?: number;
}

export interface AgentRunResult<TOutput = undefined> extends RunResult {
  output: TOutput;
}

export type AgentRunner = <TOutput>(request: AgentRunRequest<TOutput>) => Promise<AgentRunResult<TOutput>>;

export function createAgentRunner(logger: InvocationLogger, factoryRoot: string): AgentRunner {
  return async <TOutput>(request: AgentRunRequest<TOutput>): Promise<AgentRunResult<TOutput>> => {
    const base = {
      cwd: request.cwd,
      sandbox: sandboxProvider(request.harness, factoryRoot, request.cwd),
      branchStrategy: { type: "head" as const },
      name: request.name,
      agent: ticketAgent(request.harness),
      logging: { type: "file" as const, path: logger.agentLogPath(request.logName) },
      promptFile: request.promptFile,
      promptArgs: request.promptArgs,
      ...(request.maxIterations === undefined ? {} : { maxIterations: request.maxIterations }),
    };
    if (request.output === undefined) {
      const result = request.completionSignal === undefined
        ? await sandcastleRun(base)
        : await sandcastleRun({ ...base, completionSignal: request.completionSignal });
      return result as AgentRunResult<TOutput>;
    }
    const withOutput = request.completionSignal === undefined
      ? { ...base, output: request.output }
      : { ...base, completionSignal: request.completionSignal, output: request.output };
    return await sandcastleRun(withOutput);
  };
}
