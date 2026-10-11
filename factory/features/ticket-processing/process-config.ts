import type { GitProvider } from "../../infrastructure/git-provider/git-provider.js";
import type { InvocationLogger } from "../../infrastructure/logging/invocation-log.js";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import type { CommandFailure } from "../../infrastructure/git-provider/git.js";

// Workflow-owned configuration and outcome data; stage features never see these.

export interface ProcessConfig {
  readonly ticketsDir: string;
  readonly factoryRoot: string;
  readonly harness: AgentHarness;
  readonly logger: InvocationLogger;
  readonly gitProvider: GitProvider;
  readonly runAgent: AgentRunner;
}

export interface TicketOutcome {
  readonly ticketId: string;
  readonly attemptId: string;
  readonly completed: boolean;
  readonly destination: string;
  readonly failure?: CommandFailure;
}
