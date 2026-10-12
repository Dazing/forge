import type { GitProvider } from "../../infrastructure/git-provider/git-provider.js";
import type { InvocationLogger } from "../../infrastructure/logging/invocation-log.js";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";

// Workflow-owned configuration; stage features never see coordinator state.

export interface ProcessConfig {
  readonly ticketsDir: string;
  readonly factoryRoot: string;
  readonly harness: AgentHarness;
  readonly logger: InvocationLogger;
  readonly gitProvider: GitProvider;
  readonly runAgent: AgentRunner;
  readonly maxParallel: number;
  readonly ticketAttemptsPerCycle: number;
}

