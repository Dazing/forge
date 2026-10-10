import { dockerfilePath, IMAGE_NAME, type AgentHarness } from "../sandbox/sandbox.js";

// Command-line surface of the Sandcastle runner, split from main.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

export type RunOptions = Readonly<{ repo: string; ticketPaths: string[]; agentHarness: AgentHarness }>;

function printHelp(): void {
  console.log(`Usage: npm run sandcastle -- --repo <target-repository> --ticket <markdown-path> [--ticket <markdown-path> ...]

Runs up to ten planning iterations against a separately materialized Git repository.

Options:
  --repo <path>     Target repository to modify and merge into (required)
  --ticket <path>   Host Markdown ticket; repeat for multiple tickets (required)
  --agent-harness <pi|oh-my-pi>  Agent harness for every stage (default: pi)
  -h, --help        Show this help without requiring Docker

Prerequisites for a run: Docker, an image built with
  npx sandcastle docker build-image --image-name ${IMAGE_NAME} --dockerfile ${dockerfilePath}
and host access to https://openai.taila49adb.ts.net/v1 through Tailscale.`);
}

/** Parse the runner flags; prints help and returns undefined for --help, and rejects unknown flags, missing values, repeated --repo/--agent-harness, and unknown harnesses. */
export function parseArgs(argv: readonly string[]): RunOptions | undefined {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return undefined;
  }

  let repo: string | undefined;
  let agentHarness: AgentHarness | undefined;
  const ticketPaths: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument !== "--repo" && argument !== "--ticket" && argument !== "--agent-harness") {
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
    } else if (argument === "--agent-harness") {
      if (agentHarness !== undefined) throw new Error("--agent-harness may be supplied only once.");
      if (value !== "pi" && value !== "oh-my-pi") {
        throw new Error(`Unknown agent harness: ${value}. Expected pi or oh-my-pi.`);
      }
      agentHarness = value;
    } else {
      ticketPaths.push(value);
    }
  }

  if (!repo) {
    throw new Error("Missing required --repo <target-repository>. Use --help for usage.");
  }
  if (ticketPaths.length === 0) {
    throw new Error("Supply at least one --ticket <markdown-path>. Use --help for usage.");
  }
  return { repo, ticketPaths, agentHarness: agentHarness ?? "pi" };
}
