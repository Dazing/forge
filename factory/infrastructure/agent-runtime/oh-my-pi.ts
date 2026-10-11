import { homedir } from "node:os";
import { join } from "node:path";
import { pi, type AgentProvider, type PiOptions } from "@ai-hero/sandcastle";

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** OMP shares Pi's JSON event and session-file formats, but not its CLI or paths. */
export function ohMyPi(model: string, options: PiOptions = {}): AgentProvider {
  const agent = pi(model, {
    ...options,
    sessionStorage: {
      hostSessionsDir: join(homedir(), ".omp", "agent", "sessions"),
      sandboxSessionsDir: "/home/agent/.omp/agent/sessions",
      ...options.sessionStorage,
    },
  });
  function args(prompt: string, skipPermissions: boolean, resumeSession?: string): string[] {
    const result = ["omp", "--model", model];
    if (options.thinking) result.push("--thinking", options.thinking);
    if (skipPermissions) result.push("--auto-approve");
    if (resumeSession) result.push("--resume", resumeSession);
    if (prompt) result.push(prompt);
    return result;
  }
  return {
    ...agent,
    name: "oh-my-pi",
    env: { ...agent.env, OMP_MCP_REQUIRE_READY: "1" },
    buildPrintCommand({ prompt, dangerouslySkipPermissions, resumeSession, forkSession }) {
      if (forkSession) throw new Error("oh-my-pi does not support Sandcastle session forking.");
      return {
        command: [...args("", dangerouslySkipPermissions, resumeSession), "--print", "--mode", "json"].map(shellEscape).join(" "),
        stdin: prompt,
      };
    },
    buildInteractiveArgs({ prompt, dangerouslySkipPermissions, resumeSession, forkSession }) {
      if (forkSession) throw new Error("oh-my-pi does not support Sandcastle session forking.");
      return args(prompt, dangerouslySkipPermissions, resumeSession);
    },
  };
}
