import { resolve } from "node:path";
import { parseArgs } from "./cli/cli.js";
import { createAgentRunner } from "./infrastructure/agent-runtime/agent-runtime.js";
import { createGitProvider } from "./infrastructure/git-provider/create-git-provider.js";
import { InvocationLogger } from "./infrastructure/logging/invocation-log.js";
import { preflightSandbox } from "./infrastructure/sandbox/sandbox.js";
import { requireDirectory } from "./shared/paths.js";
import { processTickets } from "./features/ticket-processing/index.js";

// Composition root: parse args, build the real dependencies, and start the ticket-processing daemon.
// Ticket lifecycle lives in features/tickets/, planning in features/plan-tickets/, the stage features
// implement/review/publish, the daemon workflow in features/ticket-processing/, provider integration
// in infrastructure/git-provider/, logging in infrastructure/logging/, sandbox preflight in
// infrastructure/sandbox/, and agent execution in infrastructure/agent-runtime/.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const factoryRoot = resolve(import.meta.dirname, "..");
  process.loadEnvFile(resolve(factoryRoot, ".env"));
  const gitProvider = createGitProvider(process.env);
  const ticketsDir = resolve(options.ticketsDir);
  await requireDirectory(ticketsDir, "Ticket directory");
  const logger = await InvocationLogger.create(factoryRoot, gitProvider.credential);
  await preflightSandbox(options.agentHarness, factoryRoot);
  const runAgent = createAgentRunner(logger, factoryRoot);

  await processTickets({
    ticketsDir,
    factoryRoot,
    harness: options.agentHarness,
    logger,
    gitProvider,
    runAgent,
    maxParallel: options.maxParallel,
    ticketAttemptsPerCycle: options.ticketAttemptsPerCycle,
  });
}

await run();
