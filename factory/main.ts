import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";
import { ohMyPi } from "./harness/oh-my-pi.js";

// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).
const MAX_ITERATIONS = 10;
const MAX_PARALLEL = 1;
const MODEL = "vllm-qwen38-27b";
const IMAGE_NAME = "local-sandcastle-runner:latest";
const COMPLETE = "<promise>COMPLETE</promise>";
const runnerRoot = resolve(import.meta.dirname, "..");
const skillsPath = resolve(runnerRoot, "harness/skills");
const modelsPath = resolve(import.meta.dirname, "harness/models.json");
const runLogPath = resolve(
  import.meta.dirname,
  "../.logs",
  `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
);
const execFile = promisify(execFileCallback);

const TOOL_SUMMARY_KEYS = ["path", "command", "query", "url", "description"] as const;
const MAX_TOOL_SUMMARY_LENGTH = 200;

function summarizeToolArgs(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "";
  const values = args as Record<string, unknown>;
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = values[key];
    if (typeof value !== "string") continue;
    const summary = value.replaceAll(/\s+/g, " ").trim();
    if (summary.length <= MAX_TOOL_SUMMARY_LENGTH) return summary;
    return `${summary.slice(0, MAX_TOOL_SUMMARY_LENGTH - 3)}...`;
  }
  return Object.keys(values).join(", ");
}

const MCP_TOOL_RULES = `# Required MCP tool workflow

The sandbox provides native MCP tools from roslyn and microsoft-learn.
The pinned RoslynMcp 1.2.3 exposes load_solution, load_project, load_type,
load_member, search_type, search_member, find_references, diagnose_file, and
run_tests. Read their declared schemas before calling them. For C# analysis,
call load_solution first, then load_project and the semantic navigation,
reference, and diagnostic tools rather than shell/text substitutes. If the repo
has only .csproj files, create a disposable .slnx under /tmp referencing the real
projects by absolute path, load it, and remove it before completion. Never commit
this analysis-only solution. Use run_tests
for supported tests. This server has no build tool: use dotnet build for compilation.
An executable custom test harness may require dotnet run; state why run_tests
does not apply. Do not assume APIs from another Roslyn MCP server or version.
For C#/.NET implementation or review, make a targeted Microsoft Learn
microsoft_docs_search call to ground the framework behavior relevant to the
ticket; fetch the document when the search excerpt is insufficient.
Do not silently fall back when a required MCP call fails: report the exact error.
Include the consequential MCP calls and their results in verification evidence.
`;

type AgentHarness = "pi" | "oh-my-pi";

function ticketAgent(harness: AgentHarness) {
  const agent = harness === "oh-my-pi"
    ? ohMyPi(MODEL, { thinking: "medium" })
    : sandcastle.pi(MODEL, { thinking: "medium" });
  return {
    ...agent,
    buildPrintCommand(options: sandcastle.AgentCommandOptions) {
      const invocation = agent.buildPrintCommand({
        ...options,
        prompt: `${MCP_TOOL_RULES}\n${options.prompt}`,
      });
      return {
        ...invocation,
        command: harness === "pi"
          ? `node /home/agent/.pi/agent/check-mcp.mjs && ${invocation.command}`
          : invocation.command,
      };
    },
    parseStreamLine(line: string) {
      const parsed = agent.parseStreamLine(line);
      if (parsed.length > 0 || !line.startsWith("{")) return parsed;

      try {
        const event: unknown = JSON.parse(line);
        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "tool_execution_start" &&
          "toolName" in event &&
          typeof event.toolName === "string"
        ) {
          return [
            {
              type: "tool_call" as const,
              name: event.toolName,
              args: summarizeToolArgs("args" in event ? event.args : undefined),
            },
          ];
        }
      } catch {
        // Non-JSON output and unrelated Pi events are intentionally omitted.
      }

      return parsed;
    },
  };
}

function fileLogging(name: string) {
  return {
    type: "file",
    path: resolve(runLogPath, `${name}.log`),
  } as const;
}

type Ticket = Readonly<{
  id: string;
  title: string;
  path: string;
  content: string;
  branch: string;
}>;

type PlannedTicket = Readonly<{
  id: string;
  title: string;
  branch: string;
}>;

function printHelp(): void {
  console.log(`Usage: npm run sandcastle -- --repo <target-repository> --ticket <markdown-path> [--ticket <markdown-path> ...]

Runs up to ten planning iterations against a separately materialized Git repository.

Options:
  --repo <path>     Target repository to modify and merge into (required)
  --ticket <path>   Host Markdown ticket; repeat for multiple tickets (required)
  --agent-harness <pi|oh-my-pi>  Agent harness for every stage (default: pi)
  -h, --help        Show this help without requiring Docker

Prerequisites for a run: Docker, an image built with
  npx sandcastle docker build-image --image-name ${IMAGE_NAME} --dockerfile .sandcastle/Dockerfile
and host access to https://openai.taila49adb.ts.net/v1 through Tailscale.`);
}

function parseArgs(argv: readonly string[]): { repo: string; ticketPaths: string[]; agentHarness: AgentHarness } | undefined {
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

async function requireDirectory(path: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}`, { cause: error });
  }
  if (!details.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

function ticketTitle(path: string, content: string): string {
  const heading = content.match(/^#\s+(.+?)\s*$/m)?.[1];
  return heading ?? basename(path, ".md");
}

async function loadTickets(paths: readonly string[]): Promise<Ticket[]> {
  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  const tickets: Ticket[] = [];

  for (const suppliedPath of paths) {
    const path = resolve(suppliedPath);
    if (seenPaths.has(path)) {
      throw new Error(`Ticket path was supplied more than once: ${path}`);
    }
    seenPaths.add(path);
    if (!path.toLowerCase().endsWith(".md")) {
      throw new Error(`Ticket must be a Markdown file: ${path}`);
    }

    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      throw new Error(`Could not read ticket: ${path}`, { cause: error });
    }
    if (content.trim().length === 0) {
      throw new Error(`Ticket is empty: ${path}`);
    }

    const id = createHash("sha256").update(content).digest("hex").slice(0, 16);
    if (seenIds.has(id)) {
      throw new Error(`Tickets must have distinct content; stable ticket ID ${id} is duplicated.`);
    }
    seenIds.add(id);
    tickets.push({
      id,
      title: ticketTitle(path, content),
      path,
      content,
      branch: `sandcastle/ticket-${id}`,
    });
  }

  return tickets;
}

function formatTickets(tickets: readonly Ticket[]): string {
  return tickets
    .map(
      (ticket) =>
        `<ticket id="${ticket.id}" title=${JSON.stringify(ticket.title)} branch="${ticket.branch}">\n` +
        `<host-path>${ticket.path}</host-path>\n` +
        `<content>\n${ticket.content}\n</content>\n` +
        `</ticket>`,
    )
    .join("\n\n");
}

const planSchema = z
  .object({
    tickets: z
      .array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            branch: z.string(),
          })
          .strict(),
      )
      .max(MAX_PARALLEL),
  })
  .strict();

function validatePlan(
  entries: readonly PlannedTicket[],
  available: ReadonlyMap<string, Ticket>,
  completed: ReadonlySet<string>,
): PlannedTicket[] {
  const selected = new Set<string>();
  return entries.map((candidate) => {
    if (completed.has(candidate.id)) {
      throw new Error(`Planner selected already completed ticket ${candidate.id}.`);
    }
    const ticket = available.get(candidate.id);
    if (!ticket) {
      throw new Error(`Planner selected unknown ticket ${candidate.id}; only supplied pending tickets are allowed.`);
    }
    if (selected.has(candidate.id)) {
      throw new Error(`Planner selected ticket ${candidate.id} more than once.`);
    }
    selected.add(candidate.id);
    if (candidate.title !== ticket.title) {
      throw new Error(`Planner changed title for ticket ${candidate.id}.`);
    }
    if (candidate.branch !== ticket.branch) {
      throw new Error(`Planner branch for ${candidate.id} must be ${ticket.branch}.`);
    }
    return { id: ticket.id, title: ticket.title, branch: ticket.branch };
  });
}

async function runGit(repo: string, args: readonly string[], operation: string): Promise<string> {
  try {
    const result = await execFile("git", ["-C", repo, ...args]);
    return result.stdout;
  } catch (error) {
    throw new Error(`Git failed while ${operation} in target repository ${repo}.`, { cause: error });
  }
}

async function requireCleanSandbox(
  sandbox: { exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> },
  stage: string,
): Promise<void> {
  const status = await sandbox.exec("git status --porcelain");
  if (status.exitCode !== 0) {
    throw new Error(`${stage} could not inspect the worktree: ${status.stderr.trim()}`);
  }
  if (status.stdout.trim().length > 0) {
    throw new Error(`${stage} left uncommitted changes in the branch worktree.`);
  }
}

function dockerRuntime(harness: AgentHarness) {
  const agentDirectory = `/home/agent/.${harness === "pi" ? "pi" : "omp"}/agent`;
  return docker({
    imageName: IMAGE_NAME,
    network: "host",
    mounts: [
      { hostPath: skillsPath, sandboxPath: `${agentDirectory}/skills`, readonly: true },
      { hostPath: modelsPath, sandboxPath: `${agentDirectory}/${harness === "pi" ? "models.json" : "models.yml"}`, readonly: true },
      ...(harness === "pi" ? [
        { hostPath: resolve(import.meta.dirname, "check-mcp.mjs"), sandboxPath: `${agentDirectory}/check-mcp.mjs`, readonly: true },
      ] : []),
    ],
  });
}

function requireCompletion(stage: string, result: { completionSignal?: string }): void {
  if (result.completionSignal !== COMPLETE) {
    throw new Error(`${stage} did not report successful completion with ${COMPLETE}.`);
  }
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const repo = resolve(options.repo);
  await requireDirectory(repo, "Target repository");
  await runGit(repo, ["rev-parse", "--git-dir"], "validating --repo");
  await requireDirectory(skillsPath, "Skills source");
  await stat(modelsPath);
  const initialStatus = await runGit(repo, ["status", "--porcelain"], "checking initial worktree cleanliness");
  if (initialStatus.trim().length > 0) {
    throw new Error("Target repository must have a clean worktree before Sandcastle starts.");
  }
  const tickets = await loadTickets(options.ticketPaths);
  const allTickets = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const completed = new Set<string>();

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const pending = tickets.filter((ticket) => !completed.has(ticket.id));
    if (pending.length === 0) break;
    console.log(`\n=== [planning] Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

    const planResult = await sandcastle.run({
      cwd: repo,
      sandbox: dockerRuntime(options.agentHarness),
      branchStrategy: { type: "head" },
      name: "Planner",
      agent: ticketAgent(options.agentHarness),
      logging: fileLogging(`planner-${iteration}`),
      promptFile: resolve(import.meta.dirname, "plan-prompt.md"),
      promptArgs: {
        TICKETS: formatTickets(pending),
        COMPLETED_TICKET_IDS: completed.size === 0 ? "(none)" : [...completed].join(", "),
      },
      completionSignal: "</plan>",
      output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
    });
    if (planResult.completionSignal !== "</plan>") {
      throw new Error("Planner stopped without producing a complete <plan> response.");
    }
    if (planResult.commits.length > 0) {
      throw new Error("Planner modified the target repository; planning must be read-only.");
    }
    const planningStatus = await runGit(repo, ["status", "--porcelain"], "checking planner worktree cleanliness");
    if (planningStatus.trim().length > 0) {
      throw new Error("Planner left uncommitted changes in the target repository.");
    }
    const planned = validatePlan(planResult.output.tickets, allTickets, completed);
    if (planned.length === 0) {
      throw new Error(`Planner selected no work while ${pending.length} supplied ticket(s) remain.`);
    }

    console.log(
      `[planning] Selected ${planned.length} ticket(s): ${planned.map((ticket) => ticket.id).join(", ")}`,
    );

    const outcomes = await Promise.allSettled(
      planned.map(async (plannedTicket) => {
        const ticket = allTickets.get(plannedTicket.id);
        if (!ticket) throw new Error(`Internal error: missing ticket ${plannedTicket.id}.`);


        console.log(`[${ticket.id}] Starting implementation: ${ticket.title}`);
        await using sandbox = await sandcastle.createSandbox({
          cwd: repo,
          sandbox: dockerRuntime(options.agentHarness),
          branch: ticket.branch,
        });

        const implementation = await sandbox.run({
          name: `Implementer ${ticket.id}`,
          agent: ticketAgent(options.agentHarness),
          logging: fileLogging(`implementer-${ticket.id}`),
          promptFile: resolve(import.meta.dirname, "implement-prompt.md"),
          promptArgs: {
            TICKET_ID: ticket.id,
            TICKET_TITLE: ticket.title,
            TICKET_CONTENT: ticket.content,
            BRANCH: ticket.branch,
          },
        });
        requireCompletion(`Implementation for ticket ${ticket.id}`, implementation);
        if (implementation.commits.length === 0) {
          throw new Error(`Implementation for ticket ${ticket.id} completed without a commit.`);
        }
        console.log(
          `[${ticket.id}] Implementation complete (${implementation.commits.length} commit(s)); starting review.`,
        );

        const review = await sandbox.run({
          name: `Reviewer ${ticket.id}`,
          agent: ticketAgent(options.agentHarness),
          logging: fileLogging(`reviewer-${ticket.id}`),
          promptFile: resolve(import.meta.dirname, "review-prompt.md"),
          promptArgs: {
            TICKET_ID: ticket.id,
            TICKET_TITLE: ticket.title,
            TICKET_CONTENT: ticket.content,
            BRANCH: ticket.branch,
          },
        });
        requireCompletion(`Review for ticket ${ticket.id}`, review);
        await requireCleanSandbox(sandbox, `Review for ticket ${ticket.id}`);
        console.log(`[${ticket.id}] Review complete.`);
        return ticket;
      }),
    );

    const failures = outcomes.flatMap((outcome, index) =>
      outcome.status === "rejected"
        ? [`${planned[index]?.id ?? `index ${index}`}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`]
        : [],
    );
    if (failures.length > 0) {
      throw new Error(`Implementation/review failed:\n- ${failures.join("\n- ")}`);
    }
    const implemented = outcomes.map((outcome) => {
      if (outcome.status !== "fulfilled") throw new Error("Unreachable failed outcome.");
      return outcome.value;
    });

    console.log(
      `\n=== [merge] Merging ${implemented.length} ticket(s): ${implemented.map((ticket) => ticket.id).join(", ")} ===\n`,
    );

    const mergeResult = await sandcastle.run({
      cwd: repo,
      sandbox: dockerRuntime(options.agentHarness),
      branchStrategy: { type: "head" },
      name: "Merger",
      maxIterations: 10,
      agent: ticketAgent(options.agentHarness),
      logging: fileLogging(`merger-${iteration}`),
      promptFile: resolve(import.meta.dirname, "merge-prompt.md"),
      promptArgs: {
        BRANCHES: implemented.map((ticket) => `- ${ticket.branch}`).join("\n"),
        TICKETS: formatTickets(implemented),
      },
    });
    requireCompletion("Merge", mergeResult);

    for (const ticket of implemented) {
      await runGit(repo, ["merge-base", "--is-ancestor", ticket.branch, "HEAD"], `verifying merge of ${ticket.branch}`);
    }
    const mergeStatus = await runGit(repo, ["status", "--porcelain"], "checking merged worktree cleanliness");
    if (mergeStatus.trim().length > 0) {
      throw new Error("Merge stage left uncommitted changes in the target repository.");
    }

    for (const ticket of implemented) completed.add(ticket.id);
    console.log(`[merge] Complete: ${implemented.map((ticket) => ticket.id).join(", ")}`);
  }

  if (completed.size !== tickets.length) {
    const remaining = tickets.filter((ticket) => !completed.has(ticket.id)).map((ticket) => ticket.id);
    throw new Error(`Ten planning iterations ended with uncompleted tickets: ${remaining.join(", ")}`);
  }
  console.log(`\nAll ${completed.size} supplied ticket(s) completed.`);
}

await run();
