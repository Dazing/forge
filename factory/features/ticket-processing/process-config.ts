import type { GitProviderRegistry } from "../../infrastructure/git-provider/git-provider.js";
import type { GitHubBacklog } from "../../infrastructure/github-backlog/index.js";
import type { InvocationLogger } from "../../infrastructure/logging/invocation-log.js";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import type { BacklogWorkflow } from "./backlog-workflow.js";
import type { PublicationLedger } from "./publication-ledger.js";

// Workflow-owned configuration; stage features never see coordinator state.

export interface ProcessConfig {
  readonly factoryRoot: string;
  readonly harness: AgentHarness;
  readonly logger: InvocationLogger;
  readonly providers: GitProviderRegistry;
  readonly backlog: GitHubBacklog;
  readonly workflow: BacklogWorkflow;
  readonly ledger: PublicationLedger;
  readonly runAgent: AgentRunner;
  readonly maxParallel: number;
  readonly ticketAttemptsPerCycle: number;
}
