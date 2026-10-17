import { resolve } from "node:path";
import { parseArgs } from "./cli/cli.js";
import { createAgentRunner } from "./infrastructure/agent-runtime/agent-runtime.js";
import { createGitHubBacklog } from "./infrastructure/github-backlog/index.js";
import { createGitProviderRegistry } from "./infrastructure/git-provider/create-git-provider.js";
import { InvocationLogger } from "./infrastructure/logging/invocation-log.js";
import { preflightSandbox } from "./infrastructure/sandbox/sandbox.js";
import { redactSecrets } from "./shared/redact-secret.js";
import { BacklogWorkflow, createIssueAuthorizationReader, processTickets, PublicationLedger } from "./features/ticket-processing/index.js";

// Composition root: parse args, build the real dependencies, and start the ticket-processing daemon.
// Ticket lifecycle lives in features/tickets/, planning in features/plan-tickets/, the stage features
// implement/review/publish, the daemon workflow in features/ticket-processing/, provider integration
// in infrastructure/git-provider/, backlog integration in infrastructure/github-backlog/, logging in
// infrastructure/logging/, sandbox preflight in infrastructure/sandbox/, and agent execution in
// infrastructure/agent-runtime/.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const factoryRoot = resolve(import.meta.dirname, "..");
  process.loadEnvFile(resolve(factoryRoot, ".env"));
  const targetProviders = createGitProviderRegistry(process.env);
  // Constructing the backlog resolves the configured Project URL into its node id through one read-only
  // GitHub request, so an unusable destination stops the run before any invocation directory or sandbox work.
  const backlog = await createGitHubBacklog(process.env);
  const providers = { ...targetProviders, secrets: [...targetProviders.secrets, ...backlog.secrets] };
  const ledger = PublicationLedger.open(factoryRoot);
  const workflow = new BacklogWorkflow(backlog, ledger, (text) => redactSecrets(providers.secrets, text), undefined, createIssueAuthorizationReader({ backlog, providers }));
  const logger = await InvocationLogger.create(factoryRoot, providers.secrets);
  await preflightSandbox(options.agentHarness, factoryRoot);
  await workflow.validate();
  const runAgent = createAgentRunner(logger, factoryRoot);

  await processTickets({
    factoryRoot,
    harness: options.agentHarness,
    logger,
    providers,
    backlog,
    workflow,
    ledger,
    runAgent,
    maxParallel: options.maxParallel,
    ticketAttemptsPerCycle: options.ticketAttemptsPerCycle,
  });
}

await run();
