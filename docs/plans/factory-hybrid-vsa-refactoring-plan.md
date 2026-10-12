# Factory hybrid vertical-slice refactoring plan

## Outcome and scope

Refactor `factory/` around ticket capabilities while keeping agent execution, sandboxing, Git/provider access, and logging centralized. `ticket-processing` owns the explicit workflow; individual stage features own prompts, stage inputs, output validation, and success conditions.

This is a behavior-preserving refactor, not a pipeline redesign. Preserve GitHub and Azure DevOps support as currently implemented. No mediator, event bus, stage registry, configurable pipeline, new concurrency, retries, persistence, cancellation semantics, or provider API changes. Implementation is not part of this planning change.

## Inspected baseline

The current provider migration is integrated: `main.ts` selects a `GitProvider`, `loadTicket` validates repository URLs through it, and the orchestrator calls `gitProvider.createDraftPullRequest`. The previously observed stale `shared/git.js` and GitHub-service imports are no longer present in the inspected entry point/orchestrator.

Checks executed when preparing this plan:

| Check | Observed result |
|---|---|
| `npm run sandcastle -- --help` | Passed; provider-neutral help rendered |
| `npm run typecheck` | Passed |
| `npm test` | 72 tests passed; zero failures or skips |

These checks establish a runnable help/import baseline and current automated coverage, not a live agent-to-PR run. Docker/model execution and real remote publication were not exercised.

## Architecture decisions

1. Use six flat capability/feature folders: `tickets`, `ticket-processing`, `plan-tickets`, `implement-ticket`, `review-ticket`, and `publish-pull-request`. Do not add nested slice catalogs for features that expose one operation.
2. Every feature has a narrow `index.ts`. Cross-feature consumers import only that public surface. Same-feature helpers and tests may import their own internals.
3. `ticket-processing` is a workflow-owning feature. It may call stage features through their public APIs. Stage features may not call each other or import the coordinator, even through its public API.
4. `main.ts` remains the host composition root: parse arguments, resolve paths, load configuration, create dependencies, perform startup checks, invoke processing. No polling state or ticket settlement lives there.
5. Preserve the recently consolidated Git integration as a unit at `infrastructure/git-provider/`, including `git.ts`. Do not split subprocess code into another package solely for architectural symmetry.
6. Keep invocation-scoped infrastructure outside `shared/`. Create the provider, logger, and configured agent runtime in the composition root and pass them explicitly.
7. `shared/` contains pure utilities and generic path checks only. Extract `redactSecret` there so provider adapters and ticket annotations do not depend on the logger implementation.
8. Each stage declares its own input/output contract. Do not pass `SolveContext`, daemon state, or the coordinator's private `TicketAttempt` to stages. Small structural input overlap is preferable to a shared domainless context abstraction.
9. Keep PR-content generation and publication in one feature because the current capability consumes the generated content immediately to publish a draft PR. Its internal substeps remain explicit.
10. Preserve prompt contents, model settings, MCP instructions, harness behavior, and logging identities during relocation.

## Target structure

```text
factory/
  main.ts
  cli/
    cli.ts
  features/
    tickets/
      index.ts
      ticket.ts
      ticket-files.ts
      ticket-lifecycle.ts
      ticket-files.test.ts
      ticket-lifecycle.test.ts
    ticket-processing/
      index.ts
      process-tickets.ts
      process-iteration.ts
      execute-attempt.ts
      settle-attempt.ts
      workspace.ts
      execute-attempt.test.ts
      process-iteration.test.ts
      workspace.test.ts
    plan-tickets/
      index.ts
      plan-tickets.ts
      plan-schema.ts
      plan-prompt.md
      plan-tickets.test.ts
    implement-ticket/
      index.ts
      implement-ticket.ts
      implement-prompt.md
      implement-ticket.test.ts
    review-ticket/
      index.ts
      review-ticket.ts
      review-prompt.md
      review-ticket.test.ts
    publish-pull-request/
      index.ts
      publish-pull-request.ts
      pull-request-schema.ts
      pull-request-prompt.md
      publish-pull-request.test.ts
  infrastructure/
    agent-runtime/
      agent-runtime.ts
      create-agent.ts
      stream-events.ts
      oh-my-pi.ts
      models.json
    sandbox/
      sandbox.ts
      Dockerfile
      check-mcp.mjs
    git-provider/
      git-provider.ts
      create-git-provider.ts
      github-provider.ts
      azure-devops-provider.ts
      git.ts
      [existing colocated provider/Git tests]
    logging/
      invocation-log.ts
      invocation-log.test.ts
  shared/
    paths.ts
    sleep.ts
    redact-secret.ts
```

File granularity is not a requirement: small schemas/helpers may remain in their feature's operation file. `process-iteration.ts` is a private bounded workflow operation used by the daemon and its behavioral verification, not another public command.

The existing `factory/harness/skills/` catalog is outside this runtime relocation. Preserve it at its current path unless actual consumers establish a necessary move; do not delete it when removing obsolete harness runtime files. `standards/skills/` remains the runtime mount source.

## Public contracts and ownership

| Feature/module | Public surface | Ownership |
|---|---|---|
| `tickets` | `Ticket`, `TicketMetadataError`, discovery/loading and annotation/movement operations with their needed input types | Ticket identity, source metadata, filesystem representation |
| `ticket-processing` | `processTickets` and its configuration/dependency types | Invocation workflow state, iterations, attempt/workspace lifetime, settlement |
| `plan-tickets` | `planTickets`, input and validated selection types | Planner formatting/schema, selection rules, complete-plan signal, factory immutability |
| `implement-ticket` | `implementTicket`, its input type | Implementation prompt, iteration limit, completion requirement |
| `review-ticket` | `reviewTicket`, its input type | Review prompt, iteration limit, completion requirement, clean workspace |
| `publish-pull-request` | `publishPullRequest`, input/result types, narrowly scoped publication-failure type | PR content validation, read-only content stage, commits-ahead check, push and draft publication |
| Agent runtime | Configured execution function and its request type | Sandcastle invocation, harness construction, sandbox selection, generic log wiring/stream adaptation |

Stage inputs contain the ticket information, workspace path, branch, attempt/log identity, and other values actually consumed by that stage. Ticket types come from `tickets/index.ts`; stages never import coordinator-owned attempt types. `publishPullRequest` returns the final SHA and provider-neutral PR result needed for completion annotation, not a terminal ticket outcome.

Keep the agent runtime small and grounded in existing Sandcastle options. Stages select prompt paths/arguments, output schemas/tags, completion signals, and iteration limits. Infrastructure must not import `Ticket`, ticket attempts, planner schemas, or stage prompts. The runtime may use Sandcastle's typed execution options/output mechanism directly rather than inventing a second schema/execution framework.

## Behavior that must remain unchanged

- `--help` returns before `.env` loading, credential validation, logger creation, or sandbox preflight. CLI flags and defaults stay unchanged.
- One provider is selected per invocation using `GIT_PROVIDER`; GitHub requires `GITHUB_TOKEN`, Azure DevOps requires `AZURE_DEVOPS_PAT`. No implicit provider default or mixed-provider queue.
- Canonical SSH URL acceptance/rejection remains provider-owned. Clone/push use SSH; tokens/PATs authorize REST publication only.
- GitHub draft payload/auth/API headers remain unchanged. Azure DevOps retains API version `7.1`, PAT Basic authentication, encoded URL segments, fully qualified branch refs, draft status, and the browser-facing PR URL.
- Provider failures preserve `CommandFailedError` fields. Azure diagnostics redact both the raw PAT and derived Basic value; logger/ticket diagnostics continue redacting the configured credential.
- Ticket ID remains a hash of the full source. Front matter, slug/title derivation, base-branch default, sorted root-level Markdown discovery, and append-only annotations retain their current semantics.
- Invocation state remains in memory: known tickets, terminal IDs, iteration count. Preserve the current use of terminal IDs in planner input, including failed attempts; do not silently change it to successful-only IDs.
- Polling sleeps 10 seconds when no tickets are pending. Do not add a new sleep/backoff when the planner selects nothing while tickets remain pending.
- Planning selects at most one ticket, by ID/title only, rejecting completed/terminal, unknown, duplicate, and title-mutated selections. Planning/validation failures remain fatal to the invocation rather than becoming ticket-attempt failures.
- Planning must not change the factory checkout's HEAD or porcelain status. Preserve the existing snapshot comparison semantics; do not replace it with a different immutability definition in this refactor.
- Attempts reserve fresh retained directories and `agent-tickets/<slug>-<attempt-id>` branches. Clone validation/postconditions and retention on failure remain unchanged.
- Sequence remains reserve → attempt annotation → workspace → implementation → review/cleanliness → PR content/immutability → commit count → final SHA → push → draft PR → completion annotation/movement.
- Agents remain responsible for producing commits. Do not introduce a new TypeScript commit stage based on stale comments/documentation mentioning commit creation.
- Implementation/review retain the three-iteration limit and `<promise>COMPLETE</promise>` requirement. Planning and content generation retain their respective closing-tag completion requirements.
- Attempt failures record diagnostics and make guarded annotation/movement attempts without stopping other selected attempts. Annotation and movement failures do not recursively restart settlement.
- After successful publication, completion annotation/movement failures remain recorded settlement failures: the outcome remains completed, with an empty destination if movement fails. Do not reclassify the attempt or republish the PR.

## Migration sequence

### 1. Establish contract coverage and relocation map

Use the baseline above as the initial evidence, rechecking only after implementation changes. Before changing exported symbols, use semantic reference navigation to enumerate their consumers, including tests and non-factory callers.

Move existing behavioral tests with their owners. Add missing regression coverage for uncertain boundaries introduced by extraction: read-only stages, missing completion, publication substage failures, and guarded settlement. Follow the existing `node:test`/assert conventions. Do not add tests for import forwarding, file contents, exact incidental wording, or wrapper choreography.

Acceptance: every preserved invariant has an existing test, a targeted regression, or an explicit smoke scenario below; ownership of each current export is assigned.

### 2. Relocate infrastructure without changing its contracts

- Move `factory/git-provider/` as a unit to `factory/infrastructure/git-provider/`, retaining its adapters, configuration factory, fetch seam, and tests.
- Move invocation logging and its tests to `infrastructure/logging/`.
- Extract `redactSecret` to `shared/redact-secret.ts`; update provider, logging, and ticket-lifecycle imports directly, without re-export shims.
- Move sandbox assets to `infrastructure/sandbox/` and `oh-my-pi.ts`/`models.json` to `infrastructure/agent-runtime/`.
- Extract generic agent construction, MCP instruction injection, stream-event handling, and execution/log wiring from `harness-agents.ts`. Keep stage-specific functions temporarily at their existing location until migrated in subsequent steps; remove them at cutover.
- Preserve `main.ts`'s repository-root calculation. Pass that root into sandbox setup/preflight so adding directory depth cannot redirect the `standards/skills` mount. Resolve model and check-MCP assets from their new owners.
- Keep generic repository snapshot reading/comparison in Git infrastructure if needed by both planning and publication; stages own when to apply it and the stage labels. Do not let publication import planning helpers.

Acceptance: configured provider behavior remains identical; help and type checking work; existing tests pass; preflight resolves real assets for both harnesses. Update the Dockerfile location in CLI help and build documentation with the move.

### 3. Establish the tickets feature and extract planning

- Move ticket representation/parsing/discovery/lifecycle code into `features/tickets/` and publish only the operations/types used by real consumers.
- Keep provider-backed repository validation in loading. Do not move provider-specific parsing into ticket metadata.
- Move `PlannedTicket`, `formatTickets`, `planSchema`, `MAX_PARALLEL`, `validatePlan`, planner invocation, and the plan prompt into `plan-tickets`.
- Move the planning snapshot checks from the orchestrator into `planTickets`.
- Return validated selections rather than exposing the raw Sandcastle result to the workflow.
- Split existing ticket tests by responsibility: metadata/discovery stays with tickets; planner schema/selection tests move to planning.

Acceptance: planner violations and factory mutations fail at the planning boundary; the workflow no longer imports planner schema/validation internals. Prompt resolution uses the feature's own location.

### 4. Extract implementation and review

- Move implementation/review invocation policy, prompts, and completion enforcement to their respective features.
- Give each feature its own narrow input contract; map the coordinator's attempt into it.
- Move post-review `requireCleanRepository` enforcement into `reviewTicket` so successful review includes that postcondition.
- Keep agent construction and stream adaptation centralized. Stage features supply their own request policies; they do not duplicate runtime mechanics.
- Preserve existing agent names, log names, prompt arguments, completion rules, and iteration limits.

Acceptance: a missing completion signal rejects either stage; dirty review output rejects review before publication. Tests assert these observable outcomes, not merely calls to the runtime.

### 5. Extract publication while preserving diagnostic substages

- Move PR content generation, schema, prompt, workspace snapshots, commit-count/final-SHA reads, push, and provider publication into `publish-pull-request`.
- Accept the already configured `GitProvider`; do not recreate it per attempt or inspect its name to branch between providers.
- Return final SHA and PR result to the coordinator. Ticket annotation/movement remains outside publication.
- Keep substage names `pull-request content`, `commit count`, `final SHA`, `push`, and `draft pull request` available to settlement. Introduce one feature-local publication error carrying the failing substage and original cause. The coordinator unwraps it before `toCommandFailure`, preserving existing command/HTTP details instead of normalizing the wrapper into a generic error.
- Do not emit terminal failure logs inside publication; the coordinator remains the settlement/reporting owner.
- Move the existing PR-schema tests from `harness-agents.test.ts` to this feature.

Acceptance: content-stage mutations and branches with no commits cannot publish; failed pushes cannot create PRs; provider failures retain their HTTP/command diagnostics and correct substage in ticket/log records. Both configured providers still work through the same publication operation.

### 6. Extract workflow state and settlement; thin the host

- Move the daemon loop, known/terminal bookkeeping, metadata failure handling, and outcome reporting from `main.ts` into `ticket-processing`.
- Move workspace reservation/creation and its tests into that feature; keep `Workspace`/`TicketAttempt` private to it.
- Extract a private bounded iteration operation used by the daemon so polling state transitions can be exercised without starting an endless run. Keep sleep/iteration behavior identical.
- Keep `execute-attempt.ts` an explicit sequential function calling public stage operations. No dynamic stage list or generic pipeline context.
- Consolidate guarded metadata/attempt settlement in `settle-attempt.ts` without conflating their distinct inputs or inventing recursive recovery.
- Retain `TicketOutcome` as workflow-owned data; stage features do not return terminal movement decisions.
- Reduce `main.ts` to startup/configuration/dependency wiring and the public `processTickets` call. Delete obsolete runtime files/imports from the old orchestration, tickets, workspace, prompts, and harness locations once all consumers are migrated; preserve unrelated skill assets.

Acceptance: the daemon owns no state in `main.ts`; stages have no coordinator imports; failed metadata does not prevent a valid sibling ticket from being considered; attempt failure and settlement failure behavior matches the preserved contracts.

### 7. Enforce architectural boundaries

The repository currently has no lint setup. Add one focused import-graph check using dependency-cruiser and expose it as `npm run check:architecture`; do not add a second lint framework solely for this refactor.

Configure it for this actual flat feature layout, rather than copying nested-slice patterns:

- Other features enter a feature only through `index.ts`, including type-only imports.
- Stage features cannot import other stage features or `ticket-processing`.
- `ticket-processing` can import public stage/ticket APIs.
- `tickets` cannot import processing or stages.
- Infrastructure cannot import features, `main.ts`, or CLI.
- Shared cannot import features, infrastructure, or host/CLI code.
- Features cannot import `main.ts` or CLI.
- Reject unresolved imports and circular module dependencies.

Validate checker effectiveness with temporary violating imports (including a type-only deep import) and observe a nonzero result, then remove them. This is checker verification, not a permanent test asserting source text. Wire the check into the repository's actual verification workflow; add a combined package verification script if there is no CI workflow to update.

## Verification and acceptance scenarios

Use real temporary files and Git repositories for filesystem/Git behavior. Substitute only nondeterministic/external boundaries: agent execution and provider HTTP via the existing fetch seam. Missing production seams should be small explicit dependency inputs, not a mock-heavy application framework.

| Area | Required evidence |
|---|---|
| CLI/startup | Real `npm run sandcastle -- --help`; it must not load credentials or perform sandbox work |
| Assets | Real preflight for both harness choices; moved model/MCP assets and unchanged standards directory resolve correctly |
| Planning | Valid ID/title selection; rejection of terminal/unknown/duplicate/title-mutated entries, excess selections, incomplete output, factory HEAD/status mutations |
| Implementation/review | Incomplete execution rejects; real dirty Git workspace rejects review and cannot proceed to publication |
| Publication | Real temporary Git source/workspace and bare remote prove commits-ahead validation, final SHA, and pushed branch; provider fetch seams verify resulting draft requests/URLs for both providers |
| Settlement | Resulting ticket files and logs prove done/failed transitions, credential redaction, collision preservation, correct publication substage, and completed outcome despite post-publication settlement failure |
| Iteration | Bounded execution proves invalid metadata settlement, valid-ticket selection, terminal bookkeeping, and suppression of already-terminal IDs |
| Architecture | Import graph passes; temporary illegal imports demonstrably fail |

After integration, run `npm run typecheck`, `npm test`, `npm run check:architecture`, and the real CLI help command. The existing recursive test glob and TypeScript factory/proof include paths already cover the target folders; no scope narrowing is permitted.

In addition to tests, use a disposable smoke driver beside the workflow's private helpers to execute a bounded real iteration with real ticket files, temporary Git repositories/bare remote, real logging, controlled agent results, and each provider's HTTP seam. Observe ticket destination, pushed SHA, and PR request/result. Include one deliberately failed stage to observe failed-ticket settlement. Label this controlled integration evidence, not a live model/remote-PR run.

For live evidence, use a disposable ticket/repository with the configured provider and selected harness. Verify sandbox startup, actual prompt loading/model execution, committed/pushed branch, draft PR, completion annotation, and terminal ticket movement. External writes must target only the authorized disposable repository. Repeat for another provider/harness only when the necessary authorized credentials/services are available; otherwise state precisely which live paths remain unverified. Tests and controlled smoke do not substitute for claiming real Docker/model/provider execution.

After smoke proof, remove disposable drivers/fixtures and update `README.md`'s implementation map, model location, Docker build path, architecture-check commands, and workflow description. Preserve historical implementation plans as history; do not rewrite them to look like current runtime documentation. Remove obsolete split-origin comments and stale claims that TypeScript creates agent commits.

## Completion criteria

- All six feature boundaries are implemented, with narrow public APIs and no stage-to-stage or stage-to-coordinator imports.
- Stage prompts/contracts/postconditions are owned locally; generic agent and provider mechanics remain centralized.
- All runtime callers are migrated directly; no compatibility barrels at old locations, deprecated aliases, or duplicate runtime implementations remain.
- GitProvider/configuration/HTTP behavior and structured diagnostics remain unchanged for both providers.
- Existing behavior remains covered without re-pinning incidental wording or adding wrapper-only tests.
- Moved assets work through real path/preflight checks; all applicable automated checks and bounded smoke scenarios pass.
- Live verification evidence and any unavailable external prerequisites are reported separately and honestly.
- Documentation matches the new runtime tree; unrelated catalogs, historical runners/plans, samples, and proof scenarios are intentionally unchanged except necessary runtime import consumers.
