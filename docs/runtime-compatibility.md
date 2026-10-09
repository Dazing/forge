# Runtime compatibility decision

Observed on 2026-10-09. This document distinguishes inspected capability from executed proof.

## Decision

The implementation stack is TypeScript 6.0.3 on Node.js 24.21.0, with `@ai-hero/sandcastle` 0.12.0, Sandcastle's OpenCode agent provider, and a Docker sandbox containing OpenCode plus .NET SDK 10.0.401.

Sandcastle was retained instead of moving to OpenHands because its released API provides the required programmatic run result, named branch strategy, structured output, stream evidence, `AbortSignal`, idle timeout, and Docker mounts. OpenCode is configured with its built-in `openai` provider and `openai/gpt-6-luna`; each attempt receives a fresh OpenCode session. The factory bind-mounts one dedicated OpenCode ChatGPT OAuth file so token refreshes persist, and never resumes Sandcastle/OpenCode sessions.

This is an implementation decision, not a successful real-runtime compatibility claim. The environment lacks both prerequisites needed for the real spike:

- No dedicated OpenCode OpenAI subscription auth file is available. The model selection is configured but has not been authenticated or exercised here.
- Neither Docker nor Podman is installed. Unprivileged user namespaces are disabled (`unshare --user --map-root-user` returned `Operation not permitted`).

OpenHands was not evaluated: missing subscription authentication and sandbox access would block it identically, while no inspected Sandcastle requirement required disproportionate custom runtime work.

The writable OAuth mount is a deliberate trust tradeoff: OpenCode needs it to persist refreshed credentials, but the coding agent runs under the same container identity and can read the token. The dedicated-file check prevents unrelated provider credentials from entering the sandbox; it cannot prevent token exfiltration by a compromised agent with outbound model access. Restrict this runtime to controlled repositories and tickets.

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
| OpenAI subscription/model | auth unavailable; `openai/gpt-6-luna` configured but unexercised |

The exact model ID comes from OpenCode's current model catalog. Compatibility still requires a real authenticated run; the configured name alone is not tool-calling evidence.

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

No dedicated OpenCode OAuth file was available. Historical local vLLM endpoint probes are no longer prerequisites for the selected runtime.

## Required real-spike procedure

Do not substitute deterministic tests for these observations. Once prerequisites exist:

1. Build `containers/agent/Dockerfile`, create a dedicated OpenCode auth data directory, and use `opencode auth login` to select OpenAI and ChatGPT Plus/Pro. The resulting `auth.json` must contain only the `openai` OAuth entry and have mode `0600`.
2. Confirm `config/factory.local.json` selects `gpt-6-luna` and references that dedicated auth file.
3. Run the dedicated compatibility scenario from a disposable sample baseline.
4. Confirm transcript evidence shows file read, edit, and `dotnet test` inside the container.
5. Run a second attempt with a different attempt/session identity and an explicit first-attempt handoff; confirm it sees workspace changes but no resumed conversation.
6. Confirm each attempt transcript contains native OpenCode `skill` tool calls for every configured skill, and that repository `AGENTS.md` is read. Read-only mount paths and prompt text alone are insufficient runtime proof.
7. Trigger cancellation and timeout; after stop confirmation, hash the workspace, wait beyond the attempted command's write interval, and confirm the hash remains unchanged.
8. Attempt a write to the read-only authoritative-suite mount and require a filesystem denial.
9. Inspect the source base ref and output branch before and after; require no base-ref change or automatic merge.
10. Retain the unedited first-run report even if it fails. Any deliberate rerun receives a new run ID.

Until all ten observations exist in `.runs/<run-id>/`, Phase 0 and all real-model proof cases are **blocked**, not passed.
