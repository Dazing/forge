import { execFileSync } from "node:child_process";

const harness = process.argv[2];
const executable = harness === "pi" ? "pi" : harness === "oh-my-pi" ? "omp" : undefined;
const expectedVersion = harness === "pi" ? "1.1.0" : "18.8.4";

try {
  if (executable === undefined) throw new Error(`Unknown agent harness ${String(harness)}.`);
  const version = execFileSync(executable, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  if (version !== expectedVersion) {
    throw new Error(`Expected ${harness} ${expectedVersion}, found ${version}. Rebuild the Sandcastle Docker image.`);
  }
  // Ignore stdin so discovery cannot consume the agent's piped prompt.
  const output = execFileSync(executable, ["mcp", "list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 4 * 1024 * 1024,
  });
  const report = JSON.parse(output);
  const required = {
    roslyn: ["load_solution", "load_project", "find_references", "diagnose_file"],
    "microsoft-learn": ["microsoft_docs_search", "microsoft_docs_fetch"],
    handoff: ["submit_handoff"],
  };
  for (const [name, tools] of Object.entries(required)) {
    const server = report.servers.find((entry) => entry.name === name);
    if (!server?.enabled || server.state !== "connected") {
      throw new Error(`Required MCP server ${name} is missing, disabled, or disconnected.`);
    }
    for (const tool of tools) {
      if (!server.tools.includes(tool) || (server.toolExposure?.[tool] ?? server.exposure) !== "direct") {
        throw new Error(`Required MCP tool ${name}/${tool} is missing or not directly exposed.`);
      }
    }
    console.error(`MCP ready: ${name}, ${server.tools.length} tools, required tools directly exposed`);
  }
} catch (error) {
  console.error(`Sandcastle MCP preflight failed: ${error.message}`);
  process.exit(1);
}
