// Concise tool-start summaries for human-readable agent logs.

/** Summarize a tool call's formatted JSON arguments: file path (with line range) for file tools, command for bash, raw JSON otherwise. */
export function summarizeToolArgs(toolName: string, args: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(args) as Record<string, unknown>;
  } catch {
    return args;
  }
  if (toolName === "read") {
    const offset = typeof parsed.offset === "number" ? parsed.offset : undefined;
    const limit = typeof parsed.limit === "number" ? parsed.limit : 1;
    const range = offset === undefined ? "" : `:${offset}-${offset + limit - 1}`;
    return `${String(parsed.path ?? "")}${range}`;
  }
  if (toolName === "bash") {
    return String(parsed.command ?? "");
  }
  if (toolName === "edit" || toolName === "write") {
    return String(parsed.path ?? "");
  }
  return args;
}
