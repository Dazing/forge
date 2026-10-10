import { dockerfilePath, IMAGE_NAME, type AgentHarness } from "../sandbox/sandbox.js";

// Command-line surface of the Sandcastle runner, split from main.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

export type RunOptions = Readonly<{ repo: string; ticketsDir: string; agentHarness: AgentHarness }>;

function printHelp(): void {
  console.log(`Usage: npm run sandcastle -- --repo <target-repository> --tickets-dir <markdown-ticket-directory>

Runs continuously as a daemon against a separately materialized Git repository, polling the ticket directory every 10 seconds.

Options:
  --repo <path>     Target repository to modify and merge into (required)
  --tickets-dir <path>  Directory of Markdown tickets; polled every 10 seconds (required)
  --agent-harness <pi|oh-my-pi>  Agent harness for every stage (default: pi)
  -h, --help        Show this help without requiring Docker

Prerequisites for a run: Docker, an image built with
  npx sandcastle docker build-image --image-name ${IMAGE_NAME} --dockerfile ${dockerfilePath}
and host access to https://openai.taila49adb.ts.net/v1 through Tailscale.`);
}

/** Parse the runner flags; prints help and returns undefined for --help, and rejects unknown flags, missing values, repeated --repo/--tickets-dir/--agent-harness, and unknown harnesses. */
export function parseArgs(argv: readonly string[]): RunOptions | undefined {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return undefined;
  }

  let repo: string | undefined;
  let ticketsDir: string | undefined;
  let agentHarness: AgentHarness | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument !== "--repo" && argument !== "--tickets-dir" && argument !== "--agent-harness") {
      throw new Error(`Unknown argument: ${argument ?? "<missing>"}. Use --help for usage.`);
    }

    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a ${argument === "--agent-harness" ? "harness" : "path"} value.`);
    }
    if (argument === "--repo") {
      if (repo !== undefined) {
        throw new Error("--repo may be supplied only once.");
      }
      repo = value;
    } else if (argument === "--tickets-dir") {
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

  if (!repo) {
    throw new Error("Missing required --repo <target-repository>. Use --help for usage.");
  }
  if (!ticketsDir) {
    throw new Error("Missing required --tickets-dir <markdown-ticket-directory>. Use --help for usage.");
  }
  return { repo, ticketsDir, agentHarness: agentHarness ?? "pi" };
}
