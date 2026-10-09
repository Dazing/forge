# Factory setup runbook

## Prerequisites

- Linux, Git, Docker daemon
- Node.js 24 with npm 11
- .NET SDK 10
- Reachable unauthenticated vLLM endpoint and exact served model ID; the model must support OpenCode tool calls

## Configure

From the repository root:

```bash
npm ci --ignore-scripts
docker build -t software-factory-agent:0.1.0 -f containers/agent/Dockerfile .
cp config/factory.example.json config/factory.local.json
```

The image enables two OpenCode MCP servers:

- `roslyn` runs RoslynMcpServer 1.5.5 locally with its context-saving `lite` tool profile. It starts against `/home/agent/workspace`; the agent can enable additional Roslyn tool groups during a session.
- `microsoft-learn` connects to the unauthenticated Microsoft Learn endpoint at `https://learn.microsoft.com/api/mcp`. Agent containers therefore require outbound HTTPS access to `learn.microsoft.com`.

Configured `standards` are native OpenCode skills. Each entry MUST point to a directory named with a valid OpenCode skill name and containing `SKILL.md` with matching `name` and a `description`. The backend mounts each directory read-only under `/home/agent/.config/opencode/skills/`; it does not copy or automatically expose the operator's global skill collection.

Edit `config/factory.local.json`:

- Set `sourceRepository` to the repository used for a standalone CLI run.
- Set `vllm.endpoint` to an endpoint reachable from the agent container.
- Set `vllm.modelId` to the exact ID returned by vLLM.
- For a host-only or Tailscale endpoint on Linux, set `sandboxNetwork` to `"host"`. Omit it to retain Docker's isolated bridge network.
- Set `attemptTimeoutSeconds` for one sandbox-agent attempt and `orchestrationTimeoutSeconds` for host workspace operations between attempts. The latter defaults to 60 seconds and prevents an unbounded stage-handoff snapshot.
- Set `standards` to the explicit skill directories required by every stage. Paths are resolved relative to the configuration file. Personal skills may be listed by absolute path, but they must remain outside the agent-writable target workspace.

Verify the endpoint through the same network mode used by the agent, then run the checks:

```bash
docker run --rm --network host --entrypoint curl software-factory-agent:0.1.0 \
  --fail https://openai.example.ts.net/v1/models
npm run check
```

Do not put credentials in the config. This POC supports only an unauthenticated vLLM endpoint on a trusted network. Host networking shares the host's network namespace and weakens container isolation; use it only when the endpoint is otherwise unreachable, such as a host Tailscale route. Keep `config/factory.local.json`, `.runs/`, and `.factory-trusted/` outside agent-writable paths.
