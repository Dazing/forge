# Repository instructions

## Scope and project

These instructions apply throughout the repository unless a more specific `AGENTS.md` applies. This is a TypeScript ESM runner for local Markdown tickets using Sandcastle, Pi or oh-my-pi, retained Git workspaces, and draft pull requests on GitHub or Azure DevOps.

Treat the hybrid vertical-slice architecture described in `docs/plans/factory-hybrid-vsa-refactoring-plan.md` as implemented. That document is historical design context, not a pending migration checklist. Preserve this architecture when making changes; do not restore the old orchestration, ticket, workspace, prompt, or harness runtime locations.

## Architecture and ownership

`factory/main.ts` is the composition root: CLI/configuration, repository-root resolution, dependency construction, startup checks, and invocation of `processTickets`. Polling state and ticket settlement belong to the workflow, not the host.

The six flat features under `factory/features/` own:

| Feature | Responsibility |
|---|---|
| `tickets` | Ticket identity, metadata, discovery/loading, annotations, and filesystem movement |
| `ticket-processing` | Daemon state, bounded iterations, attempts, workspace lifetime, sequential execution, settlement, and outcomes |
| `plan-tickets` | Planner prompt/schema, validated selections, completion signal, and factory immutability |
| `implement-ticket` | Implementation prompt/input, iteration limit, and completion enforcement |
| `review-ticket` | Review prompt/input, iteration limit, completion enforcement, and clean-workspace postcondition |
| `publish-pull-request` | Read-only PR content generation, validation, commits-ahead check, final SHA, push, and draft publication |

- Enter another feature only through its narrow `index.ts`, including type-only imports. Same-feature helpers and tests may use their own internals.
- `ticket-processing` may call public ticket and stage APIs. Stage features must not import each other or the coordinator, even through public APIs. `tickets` must not import processing or stages.
- Features must not import `main.ts` or CLI code.
- Keep stage inputs small and stage-owned. Do not expose coordinator-private attempt/workspace types or introduce a generic pipeline context.
- Keep execution explicitly sequential. Do not add a mediator, event bus, stage registry, configurable pipeline, retries, persistence, concurrency, or new cancellation semantics unless the requested change requires it.

`factory/infrastructure/` owns mechanisms:

- `agent-runtime/`: configured execution, agent/harness construction, MCP guidance, stream adaptation, generic log wiring, `models.json`, and the runtime `skills/` catalog. It must not know ticket types, planner schemas, or stage prompts. Stages choose prompts, arguments, output contracts, completion signals, and iteration limits.
- `sandbox/`: sandbox setup/preflight, `Dockerfile`, `check-mcp.mjs`, and the empty `masked.env` credential overlay. Preserve repository-root-based asset resolution; directory depth must not redirect mounts. Use host networking and mount skills/models read-only at the selected harness's native global configuration paths.
- `git-provider/`: provider configuration/adapters and Git subprocess operations as one unit. Do not split Git code merely for symmetry.
- `logging/`: invocation logs and agent log paths.

Infrastructure must not import features, host, or CLI. Construct the provider, logger, and configured runtime once in the composition root and pass dependencies explicitly.

`factory/shared/` contains pure utilities and generic path checks only, including secret redaction. It must not import features, infrastructure, host, or CLI. Do not move invocation state or feature policy there. Reject unresolved imports and circular dependencies; `.dependency-cruiser.cjs` enforces the import graph.

## Behavioral contracts

Preserve these unless explicitly changing the corresponding behavior:

- `--help` returns before `.env` loading, credentials, logging, or sandbox preflight. Preserve CLI flags/defaults.
- Select exactly one provider per invocation through `GIT_PROVIDER`, with no implicit default: GitHub uses `GITHUB_TOKEN`; Azure DevOps uses `AZURE_DEVOPS_PAT`. Provider adapters own canonical SSH URL validation. Clone/push use SSH; REST credentials are for publication only.
- Preserve provider request/authentication details and structured `CommandFailedError` diagnostics. Azure DevOps uses API version `7.1`, encoded URL segments, fully qualified branch refs, draft status, and a browser-facing PR URL. Redact raw credentials and Azure's derived Basic value in diagnostics; never expose them to agents or Git arguments.
- Factory-checkout sandboxes must shadow the repository-root `.env` with the empty read-only overlay; never remove or rewrite the host credential file. Do not mask ticket repositories' application configuration.
- Ticket IDs hash the full source. Preserve front matter, slug/title derivation, default base branch, sorted root-level Markdown discovery, and append-only annotations.
- Known tickets, terminal IDs, and iteration count stay in memory. Planner input includes terminal IDs from failed attempts as well as successful ones.
- Sleep 10 seconds when no tickets are pending. Do not add sleep/backoff when the planner selects nothing while tickets remain pending.
- Planning uses the configured harness and selects at most one ticket by ID/title. Reject terminal, unknown, duplicate, title-mutated, excess, and incomplete selections. Planning/validation failures are invocation-fatal. Preserve factory HEAD/porcelain snapshot comparison semantics.
- Attempts reserve fresh retained directories and `agent-tickets/<slug>-<attempt-id>` branches. Preserve clone validation/postconditions and retain workspaces on failure.
- Preserve order: reserve → attempt annotation → workspace → implementation → review/cleanliness → PR content/immutability → commit count → final SHA → push → draft PR → completion annotation/movement.
- Agents create commits; do not introduce a TypeScript commit stage. Implementation/review allow three iterations and require `<promise>COMPLETE</promise>`. Planning requires `</plan>` completion. PR content requires closing `<pull-request>` output tags and `<promise>COMPLETE</promise>`.
- Review success requires a clean index/worktree, including untracked files. PR content generation must not change HEAD or porcelain status; a branch with no commits ahead cannot publish.
- Publication returns final SHA and provider-neutral PR data, not a terminal ticket outcome. Preserve failure substages: `pull-request content`, `commit count`, `final SHA`, `push`, and `draft pull request`. Unwrap publication errors before converting command diagnostics. The coordinator alone owns terminal reporting/settlement.
- Attempt failures receive guarded diagnostic annotation/movement without stopping other attempts. Settlement failures must not recursively retry settlement.
- After successful publication, annotation/movement failure remains a settlement failure with a completed outcome; movement failure yields an empty destination. Never republish or reclassify that attempt.

## Editing and verification

- Use existing patterns and narrow public contracts. Trace consumers before changing exports; migrate all affected callers directly, without compatibility barrels, aliases, or duplicate implementations.
- Follow strict TypeScript/NodeNext conventions, including `.js` relative import specifiers and explicit type-only imports. Keep tests colocated with their owner using `node:test` and Node assertions.
- Test observable behavior, state transitions, boundaries, and diagnostics—not import forwarding, source text, incidental wording, or wrapper choreography.
- Use real temporary files and Git repositories for filesystem/Git coverage. Substitute external agent execution and provider HTTP only at explicit dependency seams. Never use real credentials in fixtures.
- Run focused tests while developing, then the repository checks from the root:

```bash
npm run verify                     # typecheck, recursive factory tests, architecture
npm run sandcastle -- --help       # real CLI/import smoke; no credentials or Docker needed
```

- For workflow/publication changes, also exercise a bounded iteration with real tickets, temporary repositories/bare remote, real logging, controlled agent results, and the relevant provider HTTP seam. Observe terminal files, pushed SHA, PR request/result, and failure settlement. Remove disposable drivers/fixtures afterward.
- For architecture-check changes, demonstrate rejection of temporary illegal imports, including a type-only deep import, then remove them. Do not weaken the checker or narrow TypeScript/test discovery to pass checks.
- For asset/harness changes, verify real preflight for both harnesses and correct model/MCP/skill resolution. Runtime assets include `factory/infrastructure/agent-runtime/models.json`, `factory/infrastructure/agent-runtime/skills/`, `factory/infrastructure/sandbox/masked.env`, and `factory/infrastructure/sandbox/Dockerfile`. Pi uses `~/.pi/agent/`; oh-my-pi uses `~/.omp/agent/` with the model file mounted as `models.yml`.
- Controlled integration is not live Docker/model/provider execution. Only perform live remote writes against an authorized disposable repository; report exercised paths and unavailable external prerequisites separately.

## Documentation and repository safety

When changing the codebase, review and maintain both `README.md` and `AGENTS.md` in the same change so they stay aligned with the implementation. Update affected runtime ownership, commands, configuration, behavior, and contributor instructions; leave unaffected content unchanged. Keep historical plans historical. Do not propagate stale claims that TypeScript creates agent commits or that the daemon loop lives in `main.ts`.

Preserve unrelated skill catalogs, samples, proof scenarios/evaluators/expected solutions, and historical runners unless the requested change requires touching them. Do not relocate or delete skill assets solely to match the runtime tree; use actual consumers to establish mount sources. Proof scenarios are independent local evaluator workflows, not live remote-publication evidence.

Proof scenarios reference the retained fixtures and tickets under `samples/v1-sandcastle/` and the runtime catalog under `factory/infrastructure/agent-runtime/skills/`. Keep those mappings aligned when their consumers' assets move; do not relocate sample or skill content as incidental cleanup.

Do not expose `.env` contents or credentials. Do not delete retained `.workspaces/`, `.logs/`, ticket lifecycle files, or modify remote repositories as incidental cleanup. Preserve unrelated in-progress repository changes.
