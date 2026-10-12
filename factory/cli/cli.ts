import { dockerfilePath, IMAGE_NAME, type AgentHarness } from "../infrastructure/sandbox/sandbox.js";

// Command-line surface of the Sandcastle runner, split from main.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

export type RunOptions = Readonly<{ ticketsDir: string; agentHarness: AgentHarness; maxParallel: number; ticketAttemptsPerCycle: number }>;

function printHelp(): void {
  console.log(`Usage: npm run sandcastle -- --tickets-dir <markdown-ticket-directory>

Runs continuously as a daemon, polling the ticket directory every 10 seconds. Dependency-ready tickets use fresh retained workspaces; reviewed connected groups become combined draft pull requests or reviewed-subset fallbacks.

Options:
  --tickets-dir <path>  Directory of Markdown tickets; polled every 10 seconds (required)
  --agent-harness <pi|oh-my-pi>  Agent harness for every stage (default: pi)
  --max-parallel <positive integer>  Global concurrent agent-job limit (default: 1)
  --ticket-attempts-per-cycle <positive integer>  Fresh complete attempts per ticket per cycle (default: 3)
  -h, --help        Show this help without requiring Docker

Prerequisites for a run: GIT_PROVIDER=github|azure-devops in the repository-root .env with its provider credential — GITHUB_TOKEN (fine-grained token: Metadata Read, Pull requests Write) or AZURE_DEVOPS_PAT (Code read/write, vso.code_write). One provider per invocation, so every ticket in that invocation uses that provider's canonical SSH URL:
  GitHub: git@github.com:<owner>/<repository>.git
  Azure DevOps: git@ssh.dev.azure.com:v3/<organization>/<project>/<repository>
  SSH authorization for clone and push stays independent from the REST credential. Docker, an image built with npx sandcastle docker build-image --image-name local-sandcastle-runner:latest --dockerfile factory/infrastructure/sandbox/Dockerfile, and host access to https://openai.taila49adb.ts.net/v1 through Tailscale.`);
}

/** Parse the runner flags; prints help and returns undefined for --help, and rejects unknown flags, missing values, repeated --tickets-dir/--agent-harness, and unknown harnesses. */
export function parseArgs(argv: readonly string[]): RunOptions | undefined {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return undefined;
  }

  let ticketsDir: string | undefined;
  let agentHarness: AgentHarness | undefined;
  let maxParallel: number | undefined;
  let ticketAttemptsPerCycle: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument !== "--tickets-dir" && argument !== "--agent-harness" && argument !== "--max-parallel" && argument !== "--ticket-attempts-per-cycle") {
      throw new Error(`Unknown argument: ${argument ?? "<missing>"}. Use --help for usage.`);
    }

    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--tickets-dir") {
      if (ticketsDir !== undefined) throw new Error("--tickets-dir may be supplied only once.");
      ticketsDir = value;
    } else if (argument === "--agent-harness") {
      if (agentHarness !== undefined) throw new Error("--agent-harness may be supplied only once.");
      if (value !== "pi" && value !== "oh-my-pi") throw new Error(`Unknown agent harness: ${value}. Expected pi or oh-my-pi.`);
      agentHarness = value;
    } else {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${argument} requires a positive integer.`);
      if (argument === "--max-parallel") {
        if (maxParallel !== undefined) throw new Error("--max-parallel may be supplied only once.");
        maxParallel = parsed;
      } else {
        if (ticketAttemptsPerCycle !== undefined) throw new Error("--ticket-attempts-per-cycle may be supplied only once.");
        ticketAttemptsPerCycle = parsed;
      }
    }
  }

  if (!ticketsDir) {
    throw new Error("Missing required --tickets-dir <markdown-ticket-directory>. Use --help for usage.");
  }
  return { ticketsDir, agentHarness: agentHarness ?? "pi", maxParallel: maxParallel ?? 1, ticketAttemptsPerCycle: ticketAttemptsPerCycle ?? 3 };
}
