import { resolve } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import type { RunResult } from "@ai-hero/sandcastle";
import { z } from "zod";
import { sandboxProvider, type AgentHarness } from "../sandbox/sandbox.js";
import type { InvocationLogger } from "../shared/invocation-log.js";
import { formatTickets, planSchema, type Ticket } from "../tickets/tickets.js";
import type { TicketAttempt } from "../workspace/workspace-service.js";
import { ohMyPi } from "./oh-my-pi.js";

// Agent construction and stage runs for the Sandcastle runner, split from main.ts.
// Local-ticket adaptation of upstream commit 1e15922d0a0f51d5819f3615886444d10a6aa183
// (.sandcastle/run.ts blob 58def9aeddc8680067711fe3a5399509926d1bb0).

const MODEL = "vllm-qwen38-27b";
const COMPLETE = "<promise>COMPLETE</promise>";
const TICKET_AGENT_MAX_ITERATIONS = 3;
const promptsPath = resolve(import.meta.dirname, "..", "prompts");

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

const MCP_TOOL_RULES = `# MCP tool workflow

The sandbox provides native MCP tools from roslyn and microsoft-learn.
The pinned RoslynMcp 1.2.3 exposes load_solution, load_project, load_type,
load_member, search_type, search_member, find_references, diagnose_file, and
run_tests. Use Roslyn semantic navigation for C# symbol definitions, references,
and diagnostics when those questions are material to the ticket. If the repo has
only .csproj files and semantic analysis is needed, create a disposable .slnx
under /tmp referencing the real projects by absolute path, load it, and remove
it before completion. Never commit this analysis-only solution. Use run_tests
for supported tests; an executable custom test harness may require dotnet run.
This server has no build tool, so use dotnet build for compilation.
Use microsoft_docs_search only when current official framework behavior is
needed to resolve an implementation or review question. Do not repeat checks
whose existing successful evidence remains valid. Report required tool failures
instead of silently substituting a text search, and include consequential MCP
results in verification evidence.
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

function fileLogging(logger: InvocationLogger, name: string) {
  return {
    type: "file",
    path: logger.agentLogPath(name),
  } as const;
}

function requireCompletion(stage: string, result: { completionSignal?: string }): void {
  if (result.completionSignal !== COMPLETE) {
    throw new Error(`${stage} did not report successful completion with ${COMPLETE}.`);
  }
}

/** Planner output shape extracted from the `<plan>` tag. */
export type PlanOutput = z.infer<typeof planSchema>;

/** Run one planning iteration from the factory root; fails when the planner omits the complete `<plan>` response. */
export async function runPlanAgent(
  factoryRoot: string,
  harness: AgentHarness,
  iteration: number,
  pending: readonly Ticket[],
  completed: readonly string[],
  logger: InvocationLogger,
): Promise<RunResult & { output: PlanOutput }> {
  const result = await sandcastle.run({
    cwd: factoryRoot,
    sandbox: sandboxProvider(harness),
    branchStrategy: { type: "head" },
    name: "Planner",
    agent: ticketAgent(harness),
    logging: fileLogging(logger, `planner-${iteration}`),
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

/** Run the implementer in the ticket workspace's checked-out branch; fails without the completion signal. */
export async function runImplementationAgent(
  attempt: TicketAttempt,
  harness: AgentHarness,
  logger: InvocationLogger,
): Promise<RunResult> {
  const result = await sandcastle.run({
    cwd: attempt.workspacePath,
    sandbox: sandboxProvider(harness),
    branchStrategy: { type: "head" },
    name: `Implementer ${attempt.ticket.id}`,
    agent: ticketAgent(harness),
    logging: fileLogging(logger, `implementer-${attempt.ticket.id}-${attempt.attemptId}`),
    maxIterations: TICKET_AGENT_MAX_ITERATIONS,
    promptFile: resolve(promptsPath, "implement-prompt.md"),
    promptArgs: {
      TICKET_ID: attempt.ticket.id,
      TICKET_TITLE: attempt.ticket.title,
      TICKET_CONTENT: attempt.ticket.content,
      BRANCH: attempt.branch,
      BASE_BRANCH: attempt.ticket.baseBranch,
    },
  });
  requireCompletion(`Implementation for ticket ${attempt.ticket.id}`, result);
  return result;
}

/** Run the reviewer in the ticket workspace's checked-out branch; fails without the completion signal. */
export async function runReviewAgent(
  attempt: TicketAttempt,
  harness: AgentHarness,
  logger: InvocationLogger,
): Promise<RunResult> {
  const result = await sandcastle.run({
    cwd: attempt.workspacePath,
    sandbox: sandboxProvider(harness),
    branchStrategy: { type: "head" },
    name: `Reviewer ${attempt.ticket.id}`,
    agent: ticketAgent(harness),
    logging: fileLogging(logger, `reviewer-${attempt.ticket.id}-${attempt.attemptId}`),
    maxIterations: TICKET_AGENT_MAX_ITERATIONS,
    promptFile: resolve(promptsPath, "review-prompt.md"),
    promptArgs: {
      TICKET_ID: attempt.ticket.id,
      TICKET_TITLE: attempt.ticket.title,
      TICKET_CONTENT: attempt.ticket.content,
      BRANCH: attempt.branch,
      BASE_BRANCH: attempt.ticket.baseBranch,
    },
  });
  requireCompletion(`Review for ticket ${attempt.ticket.id}`, result);
  return result;
}

/** Pull-request content shape extracted from the `<pull-request>` tag; all values trimmed and non-empty. */
export const pullRequestSchema = z
  .object({
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
  })
  .strict();

export type PullRequestOutput = z.infer<typeof pullRequestSchema>;

/** Run the read-only pull-request content agent in the ticket workspace; returns commit, title, and body content without touching Git or GitHub. */
export async function runPullRequestAgent(
  attempt: TicketAttempt,
  harness: AgentHarness,
  logger: InvocationLogger,
): Promise<PullRequestOutput> {
  const result = await sandcastle.run({
    cwd: attempt.workspacePath,
    sandbox: sandboxProvider(harness),
    branchStrategy: { type: "head" },
    name: `Pull request ${attempt.ticket.id}`,
    agent: ticketAgent(harness),
    logging: fileLogging(logger, `pull-request-${attempt.ticket.id}-${attempt.attemptId}`),
    promptFile: resolve(promptsPath, "pull-request-prompt.md"),
    promptArgs: {
      TICKET_ID: attempt.ticket.id,
      TICKET_TITLE: attempt.ticket.title,
      TICKET_CONTENT: attempt.ticket.content,
      BRANCH: attempt.branch,
      BASE_BRANCH: attempt.ticket.baseBranch,
    },
    completionSignal: "</pull-request>",
    output: sandcastle.Output.object({ tag: "pull-request", schema: pullRequestSchema }),
  });
  if (result.completionSignal !== "</pull-request>") {
    throw new Error(`Pull-request content for ticket ${attempt.ticket.id} stopped without a complete <pull-request> response.`);
  }
  return result.output;
}
