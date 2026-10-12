# Repository instructions

## Scope and project

These instructions apply throughout the repository unless a more specific `AGENTS.md` applies. This is a TypeScript ESM runner for local Markdown tickets using Sandcastle, Pi or oh-my-pi, retained Git workspaces, and draft pull requests on GitHub or Azure DevOps.

## Architecture and ownership

`factory/main.ts` is the composition root: CLI/configuration, repository-root resolution, dependency construction, startup checks, and invocation of `processTickets`. Polling state and ticket settlement belong to the workflow, not the host.

The seven flat features under `factory/features/` own:

| Feature | Responsibility |
|---|---|
| `tickets` | Declared identity/dependencies, fingerprints, discovery/evidence, lifecycle annotations, and movement |
| `ticket-processing` | Invocation graph/group state, global job leases, complete retries, dependency baselines, integration finalization, reconciliation, publication state, and settlement |
| `plan-tickets` | Exact delivery-group selection, feature-owned handoff schema, and factory immutability |
| `implement-ticket` | Ticket/dependency input, three single-iteration work runs, handoff message contract, and completion enforcement |
| `review-ticket` | Single-ticket review loop, handoff message contract, and completion enforcement |
| `integrate-tickets` | Conflict-resolution/combined-review loop, handoff conflict dispositions, and no-commit completion contract |
| `publish-pull-request` | Read-only grouped PR content, gates, safe create/extension push, provider publication/update, and returned facts |

- Enter another feature only through its narrow `index.ts`, including type-only imports. Same-feature helpers and tests may use their own internals.
- `ticket-processing` may call public ticket and stage APIs. Stage features must not import each other or the coordinator, even through public APIs. `tickets` must not import processing or stages.
- Features must not import `main.ts` or CLI code.
- Keep stage inputs small and stage-owned. Do not expose coordinator-private attempt/workspace types or introduce a generic pipeline context.
- Keep scheduling as a coordinator-owned bounded ready queue. Do not add a mediator, event bus, stage registry, distributed state, partial-attempt recovery, multiple-process coordination, or new cancellation semantics.

`factory/infrastructure/` owns mechanisms:

- `agent-runtime/`: configured execution, agent/harness construction, generic feature-supplied handoff transport, MCP guidance, safe stream adaptation, generic log wiring, `models.json`, and the runtime `skills/` catalog. It must not know ticket types, planner schemas, or stage prompts. Stages choose prompts, handoff descriptions/schemas/validators, arguments, and iteration limits.
- `sandbox/`: sandbox setup/preflight, isolated per-run handoff mounts, `Dockerfile`, `check-mcp.mjs`, and the empty `masked.env` credential overlay. Preserve repository-root-based asset resolution; directory depth must not redirect mounts. Use host networking and mount skills/models read-only at the selected harness's native global configuration paths.
- `git-provider/`: provider configuration/adapters and Git subprocess operations as one unit. Do not split Git code merely for symmetry.
- `logging/`: invocation logs and agent log paths.

Infrastructure must not import features, host, or CLI. Construct the provider, logger, and configured runtime once in the composition root and pass dependencies explicitly.

`factory/shared/` contains pure utilities and generic path checks only, including secret redaction. It must not import features, infrastructure, host, or CLI. Do not move invocation state or feature policy there. Reject unresolved imports and circular dependencies; `.dependency-cruiser.cjs` enforces the import graph.

## Behavioral contracts

Preserve these unless explicitly changing the corresponding behavior:

- Human-readable stage logs include concise summaries for every Pi-compatible `tool_execution_start`, regardless of native, lowercase, or MCP tool name. Raw stream events, tool output, and thinking blocks remain omitted. `submit_handoff` summaries must never include its arguments.
- Every planner, implementation, review, integration, and pull-request-content run receives one tool named `submit_handoff` whose description and strict JSON Schema come from the owning feature. Infrastructure may transport and revalidate the generic payload but must not own a union or registry of stage schemas.
- Each run uses a unique nonce-bearing control channel outside the repository: mount the contract read-only and only that run's result directory writable. The first valid handoff is atomically immutable; invalid arguments may be corrected in the same agent turn; stale, duplicate, malformed, oversized, or wrong-tool envelopes fail safely; cleanup runs after success and failure.
- Assistant prose has no completion authority. A missing accepted handoff is incomplete. Implementation, review, and integration retry only `MissingAgentHandoffError` within their three-run loops; host validation, transport, infrastructure, and accepted-handoff postcondition failures are immediate.
- `--help` returns before `.env` loading, credentials, logging, or sandbox preflight. Preserve CLI flags/defaults.
- Select exactly one provider per invocation through `GIT_PROVIDER`, with no implicit default: GitHub uses `GITHUB_TOKEN`; Azure DevOps uses `AZURE_DEVOPS_PAT`. Provider adapters own canonical SSH URL validation. Clone/push use SSH; REST credentials are for publication only.
- Preserve provider request/authentication details and structured `CommandFailedError` diagnostics. Azure DevOps uses API version `7.1`, encoded URL segments, fully qualified branch refs, draft status, and a browser-facing PR URL. Redact raw credentials and Azure's derived Basic value in diagnostics; never expose them to agents or Git arguments.
- Factory-checkout sandboxes must shadow the repository-root `.env` with the empty read-only overlay; never remove or rewrite the host credential file. Do not mask ticket repositories' application configuration.
- Ticket IDs are explicitly declared stable identities; preserve the full-source `sourceHash`, annotation-aware `requirementsHash`, dependency metadata, front matter, slug/title derivation, default base branch, sorted root-level Markdown discovery, and append-only annotations.
- Graph/checkpoint/publication state is invocation-memory only. Component IDs are retained as membership changes. Prior lifecycle evidence blocks affected work for operator reconciliation; unrelated fresh groups continue. Record each newly discovered or changed scheduling block in `main.log` and stderr with provider credentials redacted before planner selection.
- Sleep 10 seconds when no active tickets remain or when the active queue has no runnable delivery group, then rediscover tickets. Empty planner selections and retryable runnable work add no planner/retry backoff.
- Planning uses the configured harness and selects at most one exact supplied delivery group through `submit_handoff`. Reject unknown groups, changed membership/order/titles, duplicates, excess, missing handoffs, or factory mutations. Only an accepted `{ groups: [] }` is an empty selection.
- `--max-parallel` defaults to `1` and limits every agent job through one invocation lease pool. `--ticket-attempts-per-cycle` defaults to `3`; complete retries use fresh retained workspaces and reset next cycle without a lifetime cap.
- Attempts start at a validated canonical base, one-parent review checkpoint, reviewed multi-parent integration checkpoint, or verified refreshed merged base. Preserve origin, branch/SHA/cleanliness checks, sibling isolation, pinned cycle baselines, and retained failed workspaces.
- Preserve order inside an attempt: reserve → attempt annotation → dependency-based workspace → implementation → implementation checkpoint/trace/annotation → review → review checkpoint/trace/annotation. Publication occurs only after group runnable work settles and reviewed candidates are integrated.
- Agents never commit. Implementation/review retain their three single-iteration loops. Integration also permits three single-iteration repair runs, may enter with pending merges, must resolve all entries and document every conflict, and must leave HEAD/branch unchanged. The coordinator alone creates and validates multi-parent integration commits.
- Each successful mutating stage produces exactly one checkpoint commit. Preserve the checkpoint contract: recheck the expected branch and the HEAD captured at stage entry, require no unmerged porcelain entries, `git add --all` without force-adding ignored files, compute `Factory-Changes` from the staged tree, append the runner-owned trailers (`Factory-Ticket`, `Factory-Attempt`, `Factory-Stage`, `Factory-Outcome`, `Factory-Changes`, `Factory-Agent-Log`), reject provider credential material (including Azure's derived Basic value) before writing the message, commit with `--allow-empty` as argv and the command-local `Factory Runner <factory-runner@localhost>` identity, then require exactly one new single-parent commit whose parent is the captured HEAD, on the expected branch, with a completely clean index/worktree including untracked files. Return `{ parentSha, checkpointSha, changes }` and advance only after the postconditions.
- After hooks run, compare the checkpoint's actual tree-change outcome against its recorded `Factory-Changes` trailer. A mismatch fails the checkpoint and retains the commit without reset, amendment, or retry.
- An empty checkpoint is required when a successful stage changes no files, and its message states that outcome. Failed/incomplete stages get no checkpoint: retain the dirty workspace and the last successful checkpoint, and never reset, clean, amend, rebase, or continue that workspace. A checkpoint failure is reported as `implementation commit` or `review commit`; checkpoint trace/annotation failure is a distinct durable boundary that stops the attempt, blocks reuse for reconciliation, and never repeats the commit. Preserve the original `CommandFailedError` when checkpoint commands fail.
- Each checkpoint writes one `main.log` trace record (parent SHA, checkpoint SHA, changes, agent-log basename) and appends the same record to the ticket. The agent-log value is a run-relative basename, never an absolute `.logs` path.
- Review success requires a clean index/worktree, including untracked files, enforced at the checkpoint. PR content generation must not change HEAD or porcelain status; record its success at the workspace SHA it started from immediately after immutability validation and before publication checks or remote operations. A content trace-write failure is a `pull-request content` failure before push/provider HTTP. A branch with no commits ahead cannot publish, and the net tree diff between `origin/<baseBranch>` and HEAD must be nonempty, so checkpoint-only history cannot publish.
- Publication returns final SHA, provider-neutral PR data, persisted merge-method preference, head branch, and exact published title/body for safe extension tracking—not a terminal ticket outcome. Preserve failure substages: `pull-request content`, `commit count`, `change set`, `final SHA`, `push`, and `draft pull request`. The coordinator alone owns publication facts and included-ticket settlement.
- Squash-on-merge is a preference, never permission to merge: pull requests stay draft, no auto-complete, no policy bypass, no source-branch deletion, no repository-settings rewrite, and no local squash. Azure DevOps create requests carry `completionOptions` with `mergeStrategy: "squash"`, `isDraft: true`, `deleteSourceBranch: false`, and `bypassPolicy: false`, with no `autoCompleteSetBy` and no deprecated `squashMerge`; validate the returned draft state and persisted strategy, using one read-back GET when the create response omits it, and treat absence, non-draft, or a mismatched strategy as a structured draft-publication failure that records the created PR URL. GitHub's REST API has no per-PR merge-method field: create the draft normally, report `unsupported`, append a short runner-owned PR-body note requesting squash merge within the existing 5000-character body limit, and record the limitation in the completion annotation. Never use GraphQL auto-merge, ready-to-merge, a merge endpoint, or repository settings.
- Azure read-back must succeed at HTTP level and match the created PR ID, draft state, and requested squash strategy. Keep validation reasons and the known browser-facing created PR URL in structured command diagnostics consumed by settlement, including read-back transport and malformed-response failures; redact raw and derived credentials.
- Complete-attempt failures remain retryable and do not move to `failed/`; blocked descendants are not attempted. Durable checkpoint/trace/annotation ambiguity blocks reuse for reconciliation. Invalid metadata still receives guarded terminal settlement.
- Record publication facts before guarded included-ticket annotation/movement. Only included tickets move to `done/`; settlement failures never republish. Later reviewed descendants may extend an unchanged tracked draft.
- Provider extension requires exact repository/number/base/head/source SHA/title/body/draft/squash identity and a reviewed descendant. Push non-force, reread after uncertain updates, and use a fresh draft when identity is missing, closed, non-draft, or externally changed.
- Before scheduling and publication, reconcile tracked merged PRs using provider merge-result identity, refreshed-base reachability, and exact published-delta application/tree comparison. Verified included IDs are satisfied by the refreshed base; inconclusive evidence blocks affected descendants without replaying retained history.

## Editing and verification

- Use existing patterns and narrow public contracts. Trace consumers before changing exports; migrate all affected callers directly, without compatibility barrels, aliases, or duplicate implementations.
- Follow strict TypeScript/NodeNext conventions, including `.js` relative import specifiers and explicit type-only imports. Keep tests colocated with their owner using `node:test` and Node assertions.
- Test observable behavior, state transitions, boundaries, and diagnostics—not import forwarding, source text, incidental wording, or wrapper choreography.
- Use real temporary files and Git repositories for filesystem/Git coverage. Substitute external agent execution and provider HTTP only at explicit dependency seams. Never use real credentials in fixtures.
- Run focused tests while developing, then the repository checks from the root:

```bash
npm run verify                     # typecheck, recursive factory tests, architecture
npm run factory -- --help          # real CLI/import smoke; no credentials or Docker needed
```

- For workflow/publication changes, also exercise a bounded iteration with real tickets, temporary repositories/bare remote, real logging, controlled agent results, and the relevant provider HTTP seam. Observe terminal files, pushed SHA, PR request/result, and failure settlement. Remove disposable drivers/fixtures afterward.
- For architecture-check changes, demonstrate rejection of temporary illegal imports, including a type-only deep import, then remove them. Do not weaken the checker or narrow TypeScript/test discovery to pass checks.
- For asset/harness changes, verify real preflight for both harnesses and correct handoff/MCP/model/skill resolution. Runtime assets include `factory/infrastructure/agent-runtime/handoff-server.mjs`, `factory/infrastructure/agent-runtime/models.json`, `factory/infrastructure/agent-runtime/skills/`, `factory/infrastructure/sandbox/masked.env`, and `factory/infrastructure/sandbox/Dockerfile`. Pi uses `~/.pi/agent/`; oh-my-pi uses `~/.omp/agent/` with the model file mounted as `models.yml`.
- Controlled integration is not live Docker/model/provider execution. Only perform live remote writes against an authorized disposable repository; report exercised paths and unavailable external prerequisites separately.

## Documentation and repository safety

When changing the codebase, review and maintain both `README.md` and `AGENTS.md` in the same change so they stay aligned with the implementation. Update affected runtime ownership, commands, configuration, behavior, and contributor instructions; leave unaffected content unchanged. Keep historical plans historical. Do not propagate stale claims that agents create commits, that the runner performs no checkpoint commits, or that the daemon loop lives in `main.ts`.

Planning-only changes belong in `docs/plans/`. Do not add proposed-plan links, summaries, future behavior, or plan-specific instructions to `README.md`, `AGENTS.md`, or other operational documentation before implementation. Update those documents only when the corresponding behavior is implemented and verified; describe actual behavior, not intended behavior.

Preserve unrelated skill catalogs, samples, proof scenarios/evaluators/expected solutions, and historical runners unless the requested change requires touching them. Do not relocate or delete skill assets solely to match the runtime tree; use actual consumers to establish mount sources. Proof scenarios are independent local evaluator workflows, not live remote-publication evidence.

Proof scenarios reference the retained fixtures and tickets under `samples/v1-sandcastle/` and the runtime catalog under `factory/infrastructure/agent-runtime/skills/`. Keep those mappings aligned when their consumers' assets move; do not relocate sample or skill content as incidental cleanup.

Do not expose `.env` contents or credentials. Do not delete retained `.workspaces/`, `.logs/`, ticket lifecycle files, or modify remote repositories as incidental cleanup. Preserve unrelated in-progress repository changes.
