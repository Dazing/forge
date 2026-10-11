import { dockerfilePath, IMAGE_NAME, type AgentHarness } from "../sandbox/sandbox.js";

// Command-line surface of the Sandcastle runner, split from main.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

export type RunOptions = Readonly<{ ticketsDir: string; agentHarness: AgentHarness }>;

function printHelp(): void {
  console.log(`Usage: npm run sandcastle -- --tickets-dir <markdown-ticket-directory>

Runs continuously as a daemon, polling the ticket directory every 10 seconds. Each selected ticket gets a fresh clone of its own repository under .workspaces/, and completed tickets become draft GitHub pull requests.

Options:
  --tickets-dir <path>  Directory of Markdown tickets; polled every 10 seconds (required)
  --agent-harness <pi|oh-my-pi>  Agent harness for every stage (default: pi)
  -h, --help        Show this help without requiring Docker

Prerequisites for a run: GITHUB_TOKEN in the repository-root .env, SSH access to GitHub.com, Docker, an image built with
and host access to https://openai.taila49adb.ts.net/v1 through Tailscale.`);
}

/** Parse the runner flags; prints help and returns undefined for --help, and rejects unknown flags, missing values, repeated --tickets-dir/--agent-harness, and unknown harnesses. */
export function parseArgs(argv: readonly string[]): RunOptions | undefined {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return undefined;
  }

  let ticketsDir: string | undefined;
  let agentHarness: AgentHarness | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument !== "--tickets-dir" && argument !== "--agent-harness") {
      throw new Error(`Unknown argument: ${argument ?? "<missing>"}. Use --help for usage.`);
    }

    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a ${argument === "--agent-harness" ? "harness" : "path"} value.`);
    }
    if (argument === "--tickets-dir") {
      if (ticketsDir !== undefined) {
        throw new Error("--tickets-dir may be supplied only once.");
      }
      ticketsDir = value;
    } else {
      if (agentHarness !== undefined) throw new Error("--agent-harness may be supplied only once.");
      if (value !== "pi" && value !== "oh-my-pi") {
        throw new Error(`Unknown agent harness: ${value}. Expected pi or oh-my-pi.`);
      }
      agentHarness = value;
    }
  }

  if (!ticketsDir) {
    throw new Error("Missing required --tickets-dir <markdown-ticket-directory>. Use --help for usage.");
  }
  return { ticketsDir, agentHarness: agentHarness ?? "pi" };
}
