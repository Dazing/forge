# Factory setup runbook

## Prerequisites

- Linux, Git, Docker daemon
- Node.js 24 with npm 11
- .NET SDK 10
- ChatGPT Plus/Pro subscription authenticated through OpenCode

## Configure

From the repository root:

```bash
npm ci --ignore-scripts
docker build -t software-factory-agent:0.1.0 -f containers/agent/Dockerfile .
mkdir -p .factory-auth/opencode
chmod 700 .factory-auth .factory-auth/opencode
docker run --rm -it --user "$(id -u):$(id -g)" \
  -v "$PWD/.factory-auth/opencode:/home/agent/.local/share/opencode" \
  --entrypoint opencode software-factory-agent:0.1.0 auth login
chmod 600 .factory-auth/opencode/auth.json
cp config/factory.example.json config/factory.local.json
```

The image enables two OpenCode MCP servers:

- `roslyn` runs RoslynMcpServer 1.5.5 locally with its context-saving `lite` tool profile. It starts against `/home/agent/workspace`; the agent can enable additional Roslyn tool groups during a session.
- `microsoft-learn` connects to the unauthenticated Microsoft Learn endpoint at `https://learn.microsoft.com/api/mcp`. Agent containers therefore require outbound HTTPS access to `learn.microsoft.com`.

Configured `sharedSkills` and `roleSkills` entries are native OpenCode skills. Each entry MUST point to a directory named with a valid OpenCode skill name and containing `SKILL.md` with matching `name` and a `description`. The backend mounts only the shared plus active-role directories read-only under `/home/agent/.config/opencode/skills/`; it does not expose the operator's global skill collection.

Edit `config/factory.local.json`:

- Set `sourceRepository` to the repository used for a standalone CLI run.
- Set `openaiSubscription.authFile` to the dedicated OpenCode auth file created above. Paths are relative to the configuration file.
- Keep `openaiSubscription.modelId` as `gpt-6-luna` for the requested Luna 6 runtime.
- Omit `sandboxNetwork` to retain Docker's isolated bridge network unless the environment has a separate, documented networking requirement.
- Set `attemptTimeoutSeconds` for one sandbox-agent attempt, `attemptShutdownGraceSeconds` for confirmed runner shutdown after cancellation (default 10 seconds), and `orchestrationTimeoutSeconds` for host workspace operations between attempts. The latter defaults to 60 seconds and prevents an unbounded stage-handoff snapshot.
- Set `sharedSkills` to language, domain, architecture, and engineering standards required by every role. Set every `roleSkills` key shown in `config/factory.example.json`; acceptance design belongs to test design/correction, TDD to implementation/repair, and independent review to review/re-review. Empty arrays are explicit. Paths are resolved relative to the configuration file.

Configuration migration is a clean cutover. Replace `"vllm": { "endpoint": ..., "modelId": ... }` with `"openaiSubscription": { "authFile": "../.factory-auth/opencode/auth.json", "modelId": "gpt-6-luna" }`; no endpoint or API key remains in factory configuration. Replace the old `"standards": [...]` key with `"sharedSkills": [...]` for standards that truly apply to all roles, then add the complete `"roleSkills"` object from the example. Remove acceptance-design, TDD, review, and commit/publication procedures from `sharedSkills` and place them only under their owning role. There are no legacy aliases. Do not overwrite a private `factory.local.json`; migrate its repository and skill paths in place.

If `loadConfiguration` reports `sharedSkills` and `roleSkills` as undefined, the selected config still uses the old schema. Migrate that file in place as above; copying an updated example does not update an existing ignored local config.

Verify the dedicated auth file and run the checks:

```bash
test "$(jq -r 'keys | join(\",\")' .factory-auth/opencode/auth.json)" = "openai"
test "$(jq -r '.openai.type' .factory-auth/opencode/auth.json)" = "oauth"
test "$(stat -c '%a' .factory-auth/opencode/auth.json)" = "600"
npm run check
```

The auth file is bind-mounted writable so OpenCode can refresh OAuth credentials. It MUST contain only the OpenAI login: mounting a normal multi-provider OpenCode auth file would expose every stored provider credential to the autonomous agent. The agent can read the mounted OpenAI token and has outbound model access, so use this POC only with controlled repositories and tickets. Transcript redaction is defense in depth, not an exfiltration boundary. Keep `config/factory.local.json`, `.factory-auth/`, `.runs/`, and `.factory-trusted/` outside agent-writable paths.
