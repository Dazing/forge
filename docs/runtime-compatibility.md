# Runtime compatibility decision

Observed on 2026-10-09. This document distinguishes inspected capability from executed proof.

## Decision

The implementation stack is TypeScript 6.0.3 on Node.js 24.21.0, with `@ai-hero/sandcastle` 0.12.0, Sandcastle's OpenCode agent provider, and a Docker sandbox containing OpenCode plus .NET SDK 10.0.401.

Sandcastle was retained instead of moving to OpenHands because its released API provides the required programmatic run result, named branch strategy, structured output, stream evidence, `AbortSignal`, idle timeout, and Docker read-only mounts. OpenCode accepts an ordinary provider configuration for one OpenAI-compatible vLLM endpoint. The factory creates a new `run()` invocation for every attempt and never resumes Sandcastle/OpenCode sessions.

This is an implementation decision, not a successful real-runtime compatibility claim. The environment lacked both prerequisites needed for the real spike:

- No configured vLLM endpoint, model identifier, API-key reference, or matching environment-variable name was present. No listener was available on `127.0.0.1:8000`, `localhost:8000`, or `host.docker.internal:8000`.
- Neither Docker nor Podman was installed. Unprivileged user namespaces were disabled (`unshare --user --map-root-user` returned `Operation not permitted`).

OpenHands was not evaluated: missing model and sandbox access would block it identically, while no inspected Sandcastle requirement required disproportionate custom runtime work.

## Versions observed

| Component | Version/status |
|---|---|
| Linux architecture | x86-64 |
| Node.js | 24.21.0 |
| npm | 11.19.0 |
| TypeScript | 6.0.3, pinned by this repository |
| .NET SDK | 10.0.401 |
| Git | 2.39.5 |
| Sandcastle | 0.12.0, pinned by this repository |
| OpenCode container package | `opencode-ai` 1.18.35 |
| Docker | unavailable |
| Podman | unavailable |
| vLLM endpoint/model | not configured or discoverable |

The actual deployment's model identifier and quantization remain unknown. They MUST be recorded from `/v1/models` and deployment metadata before a proof run; names or quantization are never inferred.

## Checks performed

```text
node --version       -> v24.21.0
npm --version        -> 11.19.0
dotnet --version     -> 10.0.401
git --version        -> 2.39.5
docker               -> command not found
podman               -> command not found
unshare --user --map-root-user true -> Operation not permitted
```

Environment-variable names were inspected without printing values; none matched vLLM, OpenAI, endpoint, model, Sandcastle, OpenHands, LiteLLM, or Anthropic configuration. Local `/v1/models` probes returned no HTTP response.

## Required real-spike procedure

Do not substitute deterministic tests for these observations. Once prerequisites exist:

1. Build `containers/agent/Dockerfile`, expose an unauthenticated trusted-network vLLM endpoint, and set its URL and the exact served model ID in a private configuration copied from `config/factory.example.json`. Authenticated endpoints require a future credential-isolating proxy and are not supported by this POC.
2. Run the dedicated compatibility scenario from a disposable sample baseline.
3. Confirm transcript evidence shows file read, edit, and `dotnet test` inside the container.
4. Run a second attempt with a different attempt/session identity and an explicit first-attempt handoff; confirm it sees workspace changes but no resumed conversation.
5. Confirm each attempt transcript contains native OpenCode `skill` tool calls for every configured skill, and that repository `AGENTS.md` is read. Read-only mount paths and prompt text alone are insufficient runtime proof.
6. Trigger cancellation and timeout; after stop confirmation, hash the workspace, wait beyond the attempted command's write interval, and confirm the hash remains unchanged.
7. Attempt a write to the read-only authoritative-suite mount and require a filesystem denial.
8. Inspect the source base ref and output branch before and after; require no base-ref change or automatic merge.
9. Retain the unedited first-run report even if it fails. Any deliberate rerun receives a new run ID.

Until all nine observations exist in `.runs/<run-id>/`, Phase 0 and all real-model proof cases are **blocked**, not passed.
