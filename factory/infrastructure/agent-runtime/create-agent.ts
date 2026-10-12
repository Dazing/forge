import { pi, type AgentCommandOptions, type AgentProvider, type PrintCommand } from "@ai-hero/sandcastle";
import { type AgentHarness } from "../sandbox/sandbox.js";
import { parseToolExecutionStart, summarizeToolArgs } from "./stream-events.js";
import { ohMyPi } from "./oh-my-pi.js";

// Generic ticket-agent construction: model selection, MCP tool-rule injection, Pi MCP preflight,
// and stream adaptation for concise tool summaries. No stage-specific prompts live here.

const MODEL = "vllm-qwen38-27b";

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

export function ticketAgent(harness: AgentHarness): AgentProvider {
  const base = harness === "pi" ? pi(MODEL) : ohMyPi(MODEL);
  const adapted: AgentProvider = {
    ...base,
    buildPrintCommand(options) {
      const command = base.buildPrintCommand({ ...options, prompt: `${options.prompt}\n${MCP_TOOL_RULES}` });
      return { ...command, command: `node /home/agent/.factory-assets/check-mcp.mjs ${harness} && ${command.command}` };
    },
    parseStreamLine(line) {
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
