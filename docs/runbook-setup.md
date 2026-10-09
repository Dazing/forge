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

Edit `config/factory.local.json`:

- Set `sourceRepository` to the repository used for a standalone CLI run.
- Set `vllm.modelId` to the exact ID returned by vLLM.
- Change paths, image, or timeout only when required.

Set an endpoint reachable from both the host and agent container:

```bash
export VLLM_BASE_URL=http://vllm-host:8000/v1
curl --fail "$VLLM_BASE_URL/models"
npm run check
```

Do not put credentials in the config. This POC supports only an unauthenticated vLLM endpoint on a trusted network. Keep `config/factory.local.json`, `.runs/`, and `.factory-trusted/` outside agent-writable paths.
