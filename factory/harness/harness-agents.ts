import { resolve } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import type { RunResult, Sandbox, SandboxRunResult } from "@ai-hero/sandcastle";
import { z } from "zod";
import { sandboxProvider, type AgentHarness } from "../sandbox/sandbox.js";
import { formatTickets, planSchema, type Ticket } from "../tickets/tickets.js";
import { ohMyPi } from "./oh-my-pi.js";

// Agent construction and stage runs for the Sandcastle runner, split from main.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

const MODEL = "vllm-qwen38-27b";
const COMPLETE = "<promise>COMPLETE</promise>";
const promptsPath = resolve(import.meta.dirname, "..", "prompts");
const runLogPath = resolve(
  import.meta.dirname,
  "..",
  "..",
  ".logs",
  `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
);

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

function requireCompletion(stage: string, result: { completionSignal?: string }): void {
  if (result.completionSignal !== COMPLETE) {
    throw new Error(`${stage} did not report successful completion with ${COMPLETE}.`);
  }
}

/** Planner output shape extracted from the `<plan>` tag. */
export type PlanOutput = z.infer<typeof planSchema>;

/** Run one planning iteration; fails when the planner omits the complete `<plan>` response. */
export async function runPlanAgent(
  repo: string,
  harness: AgentHarness,
  iteration: number,
  pending: readonly Ticket[],
  completed: readonly string[],
): Promise<RunResult & { output: PlanOutput }> {
  const result = await sandcastle.run({
    cwd: repo,
    sandbox: sandboxProvider(harness),
    branchStrategy: { type: "head" },
    name: "Planner",
    agent: ticketAgent(harness),
    logging: fileLogging(`planner-${iteration}`),
    promptFile: resolve(promptsPath, "plan-prompt.md"),
    promptArgs: {
      TICKETS: formatTickets(pending),
      COMPLETED_TICKET_IDS: completed.length === 0 ? "(none)" : completed.join(", "),
    },
    completionSignal: "</plan>",
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });
  if (result.completionSignal !== "</plan>") {
    throw new Error("Planner stopped without producing a complete <plan> response.");
  }
  return result;
}

/** Run the implementer in the ticket's sandbox; fails without the completion signal. */
export async function runImplementationAgent(
  sandbox: Sandbox,
  ticket: Ticket,
  harness: AgentHarness,
): Promise<SandboxRunResult> {
  const result = await sandbox.run({
    name: `Implementer ${ticket.id}`,
    agent: ticketAgent(harness),
    logging: fileLogging(`implementer-${ticket.id}`),
    promptFile: resolve(promptsPath, "implement-prompt.md"),
    promptArgs: {
      TICKET_ID: ticket.id,
      TICKET_TITLE: ticket.title,
      TICKET_CONTENT: ticket.content,
      BRANCH: ticket.branch,
    },
  });
  requireCompletion(`Implementation for ticket ${ticket.id}`, result);
  return result;
}

/** Run the reviewer in the ticket's sandbox; fails without the completion signal. */
export async function runReviewAgent(
  sandbox: Sandbox,
  ticket: Ticket,
  harness: AgentHarness,
): Promise<void> {
  const result = await sandbox.run({
    name: `Reviewer ${ticket.id}`,
    agent: ticketAgent(harness),
    logging: fileLogging(`reviewer-${ticket.id}`),
    promptFile: resolve(promptsPath, "review-prompt.md"),
    promptArgs: {
      TICKET_ID: ticket.id,
      TICKET_TITLE: ticket.title,
      TICKET_CONTENT: ticket.content,
      BRANCH: ticket.branch,
    },
  });
  requireCompletion(`Review for ticket ${ticket.id}`, result);
}

/** Merge the implemented branches into the target repository head; fails without the completion signal. */
export async function runMergeAgent(
  repo: string,
  harness: AgentHarness,
  iteration: number,
  implemented: readonly Ticket[],
): Promise<void> {
  const result = await sandcastle.run({
    cwd: repo,
    sandbox: sandboxProvider(harness),
    branchStrategy: { type: "head" },
    name: "Merger",
    maxIterations: 10,
    agent: ticketAgent(harness),
    logging: fileLogging(`merger-${iteration}`),
    promptFile: resolve(promptsPath, "merge-prompt.md"),
    promptArgs: {
      BRANCHES: implemented.map((ticket) => `- ${ticket.branch}`).join("\n"),
      TICKETS: formatTickets(implemented),
    },
  });
  requireCompletion("Merge", result);
}
