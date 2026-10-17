import { pi, type AgentCommandOptions, type AgentProvider, type PrintCommand } from "@ai-hero/sandcastle";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { type AgentHarness } from "../sandbox/sandbox.js";
import { parseToolExecutionStart, summarizeToolArgs } from "./stream-events.js";
import { ohMyPi } from "./oh-my-pi.js";

// Generic ticket-agent construction: model selection, MCP tool-rule injection, Pi MCP preflight,
// and stream adaptation for concise tool summaries. No stage-specific prompts live here.

// The workspace-root model catalog is the single source for the launched model id; it is resolved
// relative to this module (like the sandbox assets) so directory depth and cwd cannot redirect it.
const rootModelsPath = resolve(import.meta.dirname, "../../../models.json");

// The catalog is the harness-facing shape both harnesses read from their mounted copy; only the
// model ids are selected here. Sampling parameters and provider settings pass through untouched.
const modelCatalogSchema = z.object({
  providers: z.record(z.string(), z.object({
    models: z.array(z.object({ id: z.string() })),
  })),
});

/** The single model id declared by the workspace-root catalog; malformed, invalid-JSON, or ambiguous catalogs fail construction. */
function catalogModelId(): string {
  let source: string;
  try {
    source = readFileSync(rootModelsPath, "utf8");
  } catch (error) {
    throw new Error(`Model catalog does not exist: ${rootModelsPath}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Model catalog is not valid JSON: ${rootModelsPath}`, { cause: error });
  }
  const parsed = modelCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Model catalog does not match the harness catalog shape: ${rootModelsPath}`, { cause: parsed.error });
  }
  const ids = Object.values(parsed.data.providers).flatMap((provider) => provider.models.map((model) => model.id));
  const modelId = ids.length === 1 ? ids[0] : undefined;
  if (modelId === undefined) {
    throw new Error(
      `Model catalog must declare exactly one model id, found ${ids.length} in ${rootModelsPath}.` +
        " The runner launches the single catalog model; it has no model-selection policy.",
    );
  }
  return modelId;
}

const MCP_TOOL_RULES = `
## MCP tools

Roslyn MCP is available for C# and .NET work. Call \`load_workspace\` once per session before any
semantic tool. Use \`find_symbol_definition\`, \`find_usages\`, \`get_diagnostics_for_file\`,
\`run_dotnet_build\`, and \`run_dotnet_test\` for code intelligence and verification. Call
\`reset_workspace\` after \`dotnet build\` so generated files are picked up. Enable tool groups with
\`list_tool_groups\` and \`enable_tool_group\` when a tool is not yet available.

\`submit_handoff\` is the authoritative stage result. Call it exactly once only after all work and
verification obligations pass. If it rejects an invalid payload, correct that call in the same turn.
After acceptance, stop without running more tools or changing files.
`;

const failedAssistantSchema = z.object({
  type: z.literal("message_end"),
  message: z.object({
    role: z.literal("assistant"),
    stopReason: z.literal("error"),
    errorMessage: z.string().min(1),
  }),
});

export function ticketAgent(harness: AgentHarness): AgentProvider & { getFailure(): Error | undefined } {
  const base = harness === "pi" ? pi(catalogModelId()) : ohMyPi(catalogModelId());
  let failure: Error | undefined;
  const adapted: AgentProvider & { getFailure(): Error | undefined } = {
    ...base,
    getFailure: () => failure,
    buildPrintCommand(options) {
      const command = base.buildPrintCommand({ ...options, prompt: `${options.prompt}\n${MCP_TOOL_RULES}` });
      return { ...command, command: `node /home/agent/.factory-assets/check-mcp.mjs ${harness} && ${command.command}` };
    },
    parseStreamLine(line) {
      // Pi can exit successfully after a failed model request. Its terminal assistant message,
      // unlike prose or an omitted handoff, is authoritative evidence of infrastructure failure.
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        raw = undefined;
      }
      const failed = failedAssistantSchema.safeParse(raw);
      if (failed.success) {
        failure ??= new Error(`${harness} model request failed: ${failed.data.message.errorMessage}`);
        return [];
      }
      const parsedEvents = base.parseStreamLine(line);
      const fallbackToolCall = parsedEvents.some((event) => event.type === "tool_call")
        ? undefined
        : parseToolExecutionStart(line);
      const events = fallbackToolCall === undefined ? parsedEvents : [...parsedEvents, fallbackToolCall];
      return events.map((event) =>
        event.type === "tool_call" ? { type: "text", text: `Tool: ${event.name} ${summarizeToolArgs(event.name, event.args)}` } : event,
      );
    },
  };
  return adapted;
}
