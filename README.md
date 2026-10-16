# Forge - A software development factory

This repository adapts Matt Pocock's Sandcastle runner into a software factory whose ticket backlog is a private GitHub repository. Locally authored Markdown tickets are published as GitHub issues on a private Project v2 board whose Status field owns ticket lifecycle, and the runner executes them in fresh retained Git workspaces against GitHub and Azure DevOps target repositories in one invocation. Agents implement, review, and resolve integrations without committing. TypeScript owns implementation/review checkpoints, reviewed multi-parent integration commits, safe pushes, and draft pull-request creation or extension. Connected dependency groups normally produce one combined reviewed draft, while failed combinations fall back to dependency-closed reviewed subsets.

The runner uses `@ai-hero/sandcastle@0.12.0`, Pi `1.1.0`, oh-my-pi `18.8.4`, and the OpenAI-compatible model ID `vllm-qwen38-27b` at `https://openai.taila49adb.ts.net/v1`. It runs continuously, polls every 10 seconds when the active queue is empty or has no runnable tickets, and bounds all agent jobs with `--max-parallel` (default `1`).

## Prerequisites

- Node.js 24 and npm 11
- Git
- Docker
- .NET SDK 10 and Python 3 for running the standalone evaluators on the host
- Host Tailscale connectivity to `https://openai.taila49adb.ts.net/v1`
- Backlog access, required by the runner and by the submission CLI:
  - `FORGE_BACKLOG_REPOSITORY` — the private backlog as `owner/repository`;
  - `FORGE_BACKLOG_PROJECT_ID` — the private Project v2 node id whose **Status** field owns lifecycle, carrying the six options `Staging`, `Ready for development`, `In progress`, `In review`, `Done`, `Blocked`;
  - `FORGE_BACKLOG_TOKEN` — a **classic** personal access token with the **`repo`** scope (private issues) and the **`project`** scope (board reads and status writes). Fine-grained tokens cannot reach Projects v2.
- Target access for the repositories the tickets declare, each independently optional so one invocation can serve a mixed backlog:
  - `GITHUB_TOKEN` — SSH authorization to push `git@github.com:<owner>/<repository>.git` from the host (the runner runs `git push` on the host, so the host's SSH key/agent must be authorized on the account), plus a fine-grained personal access token with **Metadata: Read** and **Pull requests: Write** on the target repository;
  - `AZURE_DEVOPS_PAT` — SSH authorization to push `git@ssh.dev.azure.com:v3/<organization>/<project>/<repository>` from the host, plus a personal access token scoped to **Code: Read & write** (`vso.code_write`).

Each ticket's declared repository URL selects the provider that publishes it from the credentials that are configured, so a single run can serve tickets targeting both hosts. In both cases SSH push authorization is independent from the REST credential used to create draft pull requests.

The backlog variables and the target credentials are read from the repository-root `.env` via `process.loadEnvFile`, which is gitignored. Copy `.env.example` and fill in the backlog plus at least one target credential:

```bash
cp .env.example .env
```

A missing repository-root `.env`, an incomplete backlog configuration, and no target credential at all are each fatal startup failures, before the runner reads any ticket. A backlog repository or Project that is not private fails the startup validation gate. `npm run factory -- --help` and `npm run tickets -- --help` print help without reading `.env`, credentials, logging, Docker, or the network.

Install dependencies and build the runner image:

```bash
npm install
docker build \
  --build-arg AGENT_UID="$(id -u)" \
  --build-arg AGENT_GID="$(id -g)" \
  --tag local-sandcastle-runner:latest \
  --file factory/infrastructure/sandbox/Dockerfile \
  .
```

Build directly with Docker; this factory does not use or require a `.sandcastle/` directory. The UID/GID arguments make files created by the container belong to the invoking host user.

The container uses host networking so the agent can resolve the tailnet hostname and use the host's Tailscale routes. `factory/infrastructure/agent-runtime/models.json` defines the `local-vllm` provider and is mounted read-only at `~/.pi/agent/models.json` for Pi or `~/.omp/agent/models.yml` for oh-my-pi (JSON is valid YAML); no Anthropic or OpenAI API credential is required for this local service. The catalog at `factory/infrastructure/agent-runtime/skills/` is mounted read-only at the selected harness's global skills directory, `~/.pi/agent/skills/` or `~/.omp/agent/skills/`.

Every planner, implementation, review, integration, and pull-request-content run receives one MCP tool named `submit_handoff`. The owning feature supplies that run's strict schema; the runtime writes a nonce-bearing contract to a unique host temporary directory, mounts the contract read-only and a separate result directory writable outside the repository, and revalidates the first accepted result after the agent exits. Pi and oh-my-pi preflight require the handoff server and tool. Assistant prose is diagnostic only: it cannot complete a stage.

## Running

Author tickets as local Markdown files, then publish them into the private backlog. `--dry-run` runs every gate and prints the planned effect per ticket with zero remote writes:

```bash
npm run tickets -- submit ./ticket-queue --dry-run
npm run tickets -- submit ./ticket-queue
```

Submission is idempotent per declared ticket `id`: one issue per ID, added to the configured Project as `Staging` and then moved to `Ready for development`; a ticket whose authored content changed updates its issue body; an unchanged ticket is left untouched. `--repository` and `--project` override the environment, `--json` prints one machine-readable report, and the exit codes are `0` (every ticket created, updated, or unchanged), `1` (at least one ticket failed), and `2` (usage, configuration, lock, or privacy-gate failure with zero remote writes). Both privacy gates run before any write: the backlog repository must be private and the Project must be private.

Every ticket body is strict YAML front matter followed by the requirements:

```markdown
---
id: ticket-login-redirect
name: fix-login-redirect
repository: git@github.com:acme/app.git
dependsOnTickets: []
baseBranch: main
---

# Fix login redirect

Body of the ticket...
```

An Azure DevOps target uses the Azure SSH form, so one backlog carries tickets for both providers and each ticket's URL selects its provider:

```markdown
---
id: ticket-login-redirect
name: fix-login-redirect
repository: git@ssh.dev.azure.com:v3/Contoso Team/Web App/fix-login
dependsOnTickets: []
baseBranch: release/2.1
---
```

- `name` is normalized once into a lowercase ASCII kebab-case slug. The slug must not be empty.
- `repository` must be the canonical SSH URL of a configured provider: `git@github.com:<owner>/<repository>.git` for GitHub, `git@ssh.dev.azure.com:v3/<organization>/<project>/<repository>` for Azure DevOps. HTTPS, local-path, legacy `ssh.visualstudio.com`, GitHub Enterprise, and URLs whose provider credential is absent are rejected; the ticket is reported on its issue and parked as `Blocked`.
- `id` is required, stable, case-sensitive, and must not contain whitespace or control characters. One open issue per ID; a duplicate ID blocks both issues for operator reconciliation. `dependsOnTickets` defaults to `[]`; duplicate/self references are rejected. Missing references remain blocked until the ticket arrives. Cycles and repository/base-branch mismatches reject graph execution.
- `baseBranch` is optional and defaults to `main`. Every connected dependency group uses one canonical repository and base branch.
- `sourceHash` covers the complete source. `requirementsHash` deterministically covers the authored front matter and body. Annotation-only history never changes it, so a checkpoint stays reusable; an authored change after a successful checkpoint stops that ticket ID and its descendants — the guard observes the changed requirements, the work is preserved on its branch, and the author supplies a new ID. The runner never rewrites an authored issue body.

Start the daemon from this repository; it discovers its work from the board, so there is no ticket directory to point it at:

```bash
npm run factory -- --max-parallel 1 \
  --ticket-attempts-per-cycle 3
```

Pi is the default harness; pass `--agent-harness oh-my-pi` when required. Both numeric options require positive integers and are validated before environment, credential, or sandbox work. `--max-parallel` is invocation-global across implementation, review, integration, and pull-request content jobs. `--ticket-attempts-per-cycle` controls fresh complete attempts; the default is `3`.

The daemon rediscovers the open backlog issues and their board statuses every cycle and plans at most one validated connected delivery group. Within that group, every dependency-ready ticket can run concurrently within the global limit. Planning remains serialized. Empty planner selections and retryable pending work add no backoff. An empty backlog, or a backlog with no runnable delivery group, sleeps for 10 seconds, then rediscovers so new issues and moved cards can become runnable.

### Board-driven lifecycle

The Project board owns status: `Staging` (submitted, not queued), `Ready for development` (queued), `In progress` (claimed by one attempt), `In review` (a draft pull request carries the work), `Done` (merged), and `Blocked` (work the runner cannot proceed with). Every runner write to an issue is one append-only comment marked with a runner operation key, so a restart recognises its own effects and never repeats them. The runner never rewrites an authored issue body.

1. Rediscover every open issue on the board: parse each body as an authored ticket, read its board status, resolve its provider from its declared repository, and validate declared IDs, references, cycles, and repository/base compatibility. Unparseable issues, duplicate IDs, issues missing from the board, issues whose provider credential is absent, and descendants of unsuccessful work are reported on their issues and parked as `Blocked`; they are never attempted.
2. A claimed ticket gets one start comment naming its attempt, branch, target repository, and base branch, then moves to `In progress`. Run dependency-ready tickets in isolated fresh workspaces. Roots start at the refreshed canonical base; a one-parent ticket imports the parent's clean review checkpoint; multi-parent tickets wait for a runner-owned reviewed integration baseline. Siblings never see one another's ticket-specific changes.
3. Each complete attempt runs implementation and review through three single-iteration stage loops. A missing `submit_handoff` result consumes the next stage iteration in the same uncommitted workspace; schema, transport, and accepted-result postcondition failures do not. Every successful stage receives exactly one runner-owned checkpoint, including an empty review checkpoint. Checkpoint commits use the runner-local `Factory Runner <factory-runner@localhost>` identity, so host-level Git author configuration is not required. A failed complete attempt is retained and retried in a fresh workspace from the same pinned dependency baseline, up to the cycle budget.
4. Before every agent run, the stage re-reads the issue, its board status, and its authored requirements hash. A closed issue, a status the runner did not claim, or requirements that changed mid-flight withdraw the authorization: the attempt stops before dispatching anything, the branch is pushed so the work survives, and a preservation comment records the branch, its browser link, the commit, whether it was pushed, and whether it was reviewed. The runner writes no status for a withdrawn ticket — the human's column stands.
5. Exhausted tickets are reported on their issue and parked as `Blocked`, and remain retryable for the next cycle. A credential lapse (GitHub resource inaccessible, Azure DevOps `TF401027`/`TF400813`/`vso.code_write`, SSH `Permission denied (publickey)`) is detected from the failure text, preserves the branch and the retained workspace, and parks the ticket as `Blocked` with the reason. Descendants stay blocked; successful ancestors and independent siblings remain reusable and publishable.
6. After runnable work settles, reviewed leaf candidates are merged in stable ticket-ID order in a fresh integration workspace. The integration agent resolves conflicts and reviews the combined behavior but never commits; the runner validates parents, conflict dispositions, index/tree cleanliness, and creates the merge commit. Combined review runs even for clean Git merges, and the integration loop is guarded the same way.
7. Publish only dependency-closed reviewed candidates. A failed combined review never publishes its tree; independently reviewed subsets may publish separately. Pull-request content lists included, retryable, blocked, integration-excluded tickets, and every conflict disposition. Publication re-reads every included issue before the push and again before the provider write: withdrawal leaves the branch unpushed and the provider untouched, and preserves each reviewed leaf checkpoint.
8. A tracked unchanged open draft may be extended only after provider identity, refs, source SHA, title/body, draft state, and squash preference match the durable record. The push is non-force and the provider is reread after an uncertain update. Closed, non-draft, missing, or externally changed drafts are untouched; reviewed work uses a fresh draft.
9. Record the publication intent durably, push and create or extend the draft, record the result, then settle: one publication comment on every included issue with its number, URL, head branch, included IDs, and requested merge method, then `In review`. Only issues whose settlement completed count as published, so a settlement failure never republishes. A verified merge moves an issue to `Done` and closes it completed.

Fresh workspaces and failed integrations are retained. The runner never resets, cleans, amends, rebases, force-pushes, merges a pull request, enables auto-merge, bypasses policy, deletes branches, closes an issue as anything but completed, or rewrites repository settings.

Continuation is durable. The publication ledger under `.factory-state/` (gitignored) holds one intent record before each push, one result record after each provider write, and one settlement record per issue-and-effect, each written as a same-directory temp file plus rename. At startup the runner replays unfinished settlements without republishing, then reconciles every tracked publication through the provider: an absent or closed pull request retires that record and returns its issues to `Ready for development` with a comment naming why the work restarts; a merged pull request requires a provider merge-result SHA reachable from the refreshed base, applies the exact recorded published delta to the merge result's first parent in a disposable worktree, and compares trees, moving verified issues to `Done` and blocking affected descendants on inconclusive evidence without replaying retained history. A run interrupted between intent and result resumes from the ledger and never publishes a second draft for a branch that already carries one.

Every configured credential — the backlog token and each target token — is passed explicitly to the logger, the backlog workflow, the guards, and the provider registry, and every literal occurrence is replaced with `[redacted-token]` before it reaches a log, issue comment, or command display. For Azure DevOps the encoded Basic authorization value derived from the PAT is redacted as well. No credential appears in Git arguments, URLs, logs, ticket diagnostics, preservation comments, or agent environments.

When an agent runs in the factory checkout, the sandbox overlays its repository-root `.env` with the read-only empty `factory/infrastructure/sandbox/masked.env` asset. This keeps the planner from reading the host's REST credentials without changing the host file or factory snapshot semantics. Agents running in ticket workspaces retain their own repositories' application configuration.

### Merge method preference

The runner requests squash merge as a preference only. It never merges, marks a pull request ready, bypasses provider policy, deletes the source branch, or rewrites repository settings, and pull requests stay draft.

- **Azure DevOps**: the REST `7.1` create request carries `completionOptions` with `mergeStrategy: "squash"`, `isDraft: true`, `deleteSourceBranch: false`, and `bypassPolicy: false`, and no `autoCompleteSetBy`. The response's draft state and persisted merge strategy are validated; when the create response omits `completionOptions`, one read-back GET resolves it. Read-back must have a successful HTTP status, the same pull-request ID, draft state, and the requested squash strategy. Read-back HTTP, transport, malformed-response, identity, draft, and strategy failures retain the pushed branch and any created PR; structured diagnostics preserve the failure explanation and known browser-facing PR URL while redacting the raw PAT and derived Basic value. The provider reports `squashPreference: "configured"` only after validation.
- **GitHub**: the REST API has no per-pull-request merge-method field, so the create payload carries none. The provider reports `squashPreference: "unsupported"`, the pull-request body gets a short runner-owned note asking the reviewer to select squash when merging (within the existing 5000-character body limit), and the limitation is recorded in the publication comment on every included issue. No GraphQL auto-merge, ready-to-merge, merge endpoint, or repository-settings call is made.

The published preference is recorded on every included issue's publication comment as `- Requested merge method: squash (configured|unsupported)`.

### Logs

Agent output is written under `.logs/<utc-stamp>-<6-hex>/` at the root of this runner checkout: one instance directory per invocation, named with a sortable UTC stamp (`2026-10-12_09-30-15`) plus a random suffix, with `main.log` at its root. Planner cycles write numbered transcripts under `planner/` (`planner/001.log`, `planner/002.log`). Each attempt gets one directory named `<utc-stamp>-<attempt-id>/`, and every run inside it is a numbered stage file: `implement-1.log`, `implement-2.log`, `review-1.log`, `integrate-1.log`, `pull-request-1.log`. Every allocation consumes the next number, including runs that fail, so a retry never overwrites a prior transcript, and all runs of one attempt ID share one directory.

Each transcript is a human-readable progress log containing assistant text and a concise summary for every Pi-compatible tool-start event, including lowercase native and MCP tool names, while omitting raw Pi events such as thinking blocks and tool output. `submit_handoff` events identify the tool without logging title, body, message, or conflict payloads. `main.log` is the append-only record of ticket attempts, failures, and scheduling blocks. A newly discovered or changed block is also printed to stderr with its reason before planner selection, so a run with no runnable delivery group does not appear frozen.

Each successful checkpoint appends one line to `main.log` in the form `timestamp ticket=<id> attempt=<id> stage=<stage> operation=creating stage checkpoint commit status=completed parent=<sha> checkpoint=<sha> changes=<changed|unchanged> agent-log=<invocation-relative path>`. The same invocation-relative path is the `Factory-Agent-Log` trailer on the checkpoint commit, so the log record and the commit agree. Trace a stage from the log to its commit and its agent transcript:

```bash
grep 'stage=review commit' .logs/*/main.log            # boundary records with parent/checkpoint SHAs and agent-log paths
git -C .workspaces/<slug>-<attempt-id> show <checkpoint-sha>   # message plus Factory-* trailers
git -C .workspaces/<slug>-<attempt-id> diff <parent-sha> <checkpoint-sha>   # the stage delta
cat .logs/<utc-stamp>-<6-hex>/<utc-stamp>-<attempt-id>/review-1.log  # the stage transcript
```

## Runner implementation

The runner is the `factory/` tree, split by responsibility:

- `factory/main.ts` — thin composition root: parse flags, load the repository-root `.env`, build the target-provider registry from the configured credentials and the backlog transport from `FORGE_BACKLOG_*`, open the publication ledger and backlog workflow, create the invocation logger, run the sandbox preflight, validate the backlog and board, build the agent runner, and start the ticket-processing daemon.
- `factory/cli/cli.ts` — runner flags (`--agent-harness`, `--max-parallel`, `--ticket-attempts-per-cycle`), validation, and help-first startup behavior. `factory/tickets-main.ts` and `factory/cli/tickets-cli.ts` are the separate `npm run tickets -- submit` client: argument parsing, usage, per-ticket reports, exit codes, and no sandbox preflight, queue access, or daemon.
- `factory/features/tickets/` — declared identity/dependencies, source and authored-requirements fingerprints, and validation of an issue body as a complete authored ticket source (`parseAuthoredIssueSnapshot`) with its `IssueIdentity` and the six `BACKLOG_STATUSES`. It is a leaf: it knows the authored contract, not the board.
- `factory/features/submit-tickets/` — the submission pipeline for locally authored Markdown: glob/directory sources, per-ID issue creation and guarded body updates, privacy gates, per-ID submission lock, dry-run planning, and text/JSON reports.
- `factory/features/plan-tickets/` — immutable factory-checkout planning for exact validated delivery-group IDs and member ID/title records. Execution capacity remains coordinator policy.
- `factory/features/implement-ticket/` and `review-ticket/` — stage-owned loops of up to three single-iteration agent runs, feature-owned `submit_handoff` message schemas, branch/HEAD contracts, an optional per-run authorization callback, and no agent commits. Implementation receives the pinned reviewed dependency context.
- `factory/features/integrate-tickets/` — conflict resolution and combined review for pending runner-created merges, with three repair runs, a feature-owned handoff schema for conflict dispositions, branch/HEAD protection, an optional per-run authorization callback, unresolved-entry checks, and conflict-marker rejection.
- `factory/features/publish-pull-request/` — read-only grouped content, immutable entry trace, commit-count/net-change gates, final SHA, safe non-force create/extension push with an authorization callback before the push and before the provider write, draft creation/update, uncertain-update reread, included/retryable/blocked/excluded/conflict evidence, and bounded GitHub squash note.
- `factory/features/ticket-processing/` — backlog discovery, invocation graph/component state, global agent leases, dependency-ready scheduling, fresh complete retries, dependency checkpoint import, multi-parent integration, reviewed-subset fallback, the `BacklogWorkflow` board settlement, the durable `PublicationLedger`, board-reading authorization guards, credential-lapse preservation, settlement replay, and merged-delta reconciliation.
- `factory/infrastructure/github-backlog/` — the private GitHub issue and Project v2 transport: privacy validation, issue reads/writes with revision-conflict checks, append-only comments, issue closure as completed, bulk board reads, and single status writes, with structured credential-redacted failures. It owns no lifecycle policy.
- `factory/infrastructure/git-provider/` — the provider registry (`GITHUB_TOKEN`, `AZURE_DEVOPS_PAT`), provider-neutral create/read/update contracts, browser-facing branch links, and Git mechanisms. GitHub and Azure DevOps return canonical PR state, refs, source SHA, title/body, draft status, squash capability, and merge-result SHA while preserving structured credential-redacted failures.
- `factory/infrastructure/logging/` — `invocation-log.ts` (run directory, agent log paths, redacted `main.log`).
- `factory/infrastructure/sandbox/` — `sandbox.ts` (host-network Docker provider, native read-only skill/model/server mounts, isolated per-run handoff mounts, factory credential masking, preflight), `masked.env` (empty credential overlay), `Dockerfile` (Pi 1.1.0, oh-my-pi 18.8.4, RoslynMcp 1.2.3, .NET 10 runtime, and pinned handoff MCP dependencies), and `check-mcp.mjs` (Pi/oh-my-pi MCP preflight).
- `factory/infrastructure/agent-runtime/` — generic configured execution, nonce-authenticated handoff contract/channel lifecycle, the schema-driven `submit_handoff` stdio server, safe stream summaries, agent construction, `oh-my-pi.ts`, `models.json` with `models-path.ts`, and the read-only `skills/` catalog. Feature schemas do not enter infrastructure.
- `factory/shared/` — `paths.ts`, `sleep.ts`, and `redact-secret.ts`.

The planner returns at most one exact validated delivery group and cannot bypass graph readiness. Every stage completes only through its feature-shaped `submit_handoff` result; the first valid call is immutable, invalid arguments can be corrected in the same agent turn, and prose has no completion authority. Implement, review, and integration retry only omitted handoffs within their three-run loops; agents never commit. The runner owns every checkpoint and integration commit. Planning/graph contract failures are invocation-fatal; unsuccessful complete attempts remain retryable, while durable-boundary failures require reconciliation.

## Tests

```bash
npm test          # tsx --test "factory/**/*.test.ts"
npm run typecheck
npm run check:architecture   # dependency-cruiser rules in .dependency-cruiser.cjs
npm run verify    # typecheck + tests + architecture check
npm run factory -- --help    # runner CLI import smoke, no credentials or Docker
npm run tickets -- --help    # submission CLI import smoke, no credentials or network
```

The architecture is enforced by dependency-cruiser rules in `.dependency-cruiser.cjs`:

- A feature may enter another feature only through its `index.ts`; deep imports of internal modules are rejected.
- The stage features (`plan-tickets`, `implement-ticket`, `review-ticket`, `integrate-tickets`, `publish-pull-request`) never import `ticket-processing` or each other; `ticket-processing` composes them.
- `tickets` is a leaf: it imports no other feature.
- Infrastructure (`agent-runtime`, `sandbox`, `git-provider`, `github-backlog`, `logging`) never imports features, `main.ts`, `tickets-main.ts`, or `cli/`; `shared/` never imports features or infrastructure; features never import `main.ts`, `tickets-main.ts`, or `cli/`.
- The submission host (`tickets-main.ts`) and the `submit-tickets` feature reach `tickets` only through its `index.ts` and never touch the runner host, `ticket-processing`, or a stage feature.

The skills catalog under `factory/infrastructure/agent-runtime/skills/` is excluded from the cruise: its files are read-only agent material, not production modules.

Automated coverage includes identity/fingerprint boundaries, authored-issue parsing, board discovery (statuses, unboarded issues, duplicate IDs, foreign and unparseable issues), graph chains/diamonds/missing references/invalid edges, numeric configuration, real-Git dependency baselines and sibling isolation, bounded sibling overlap, fresh retry isolation, next-cycle continuation with safe draft extension, conflict resolution evidence, reviewed-subset fallback, settlement-on-every-included-issue, board-status settlement with idempotent operation-keyed comments, durable publication intents and results with restart without a duplicate pull request, retired-publication resume, merged-delta verification and mismatch rejection, stage and publication authorization guards, credential-lapse preservation, runner-owned checkpoints, provider create/read/update requests, credential redaction, publication gates, and architecture boundaries. Provider and backlog HTTP are exercised through controlled fetch seams and in-memory backlog fixtures over real local bare remotes; live SSH/provider writes still require an authorized disposable remote.

## Proof scenarios

The five retained proof modes map fixtures to host-side tickets, skills, evaluators, and expected-solution positive controls:

| Mode | Scenario | Fixture | Ticket |
|---|---|---|---|
| Feature | `proof/scenarios/feature.json` | `samples/v1-sandcastle/feature` | `samples/v1-sandcastle/tickets/feature.md` |
| Bug | `proof/scenarios/bug.json` | `samples/v1-sandcastle/bug` | `samples/v1-sandcastle/tickets/bug.md` |
| Refactor | `proof/scenarios/refactor.json` | `samples/v1-sandcastle/refactor` | `samples/v1-sandcastle/tickets/refactor.md` |
| VSA feature | `proof/scenarios/vsa-feature.json` | `samples/v1-sandcastle/vsa-feature` | `samples/v1-sandcastle/tickets/vsa-feature.md` |
| VSA allocation | `proof/scenarios/vsa-allocation-feature.json` | `samples/v1-sandcastle/vsa-allocation-feature` | `samples/v1-sandcastle/tickets/vsa-allocation-feature.md` |

Preparation creates a timestamped repository under `.run/`, copies only the selected fixture, and initializes that copy as a new Git repository:

```bash
RUN_PATH=$(npm run --silent prepare:scenario -- proof/scenarios/vsa-allocation-feature.json)
npm run evaluate -- proof/scenarios/vsa-allocation-feature.json "$RUN_PATH"
```

`npm run evaluate -- <scenario.json> <candidate-repository>` invokes the scenario's independent evaluator and returns its pass/fail status. Expected solutions under `proof/expected/` are evaluator positive controls only; neither they nor `proof/evaluators/` are copied into an agent repository.

The sample tickets have no YAML front matter and target no provider repository, and the materialized fixtures are local paths. Proof fixtures and evaluators verify code quality in materialized local repositories; they are **not** an end-to-end remote-publication smoke path. Running the daemon end to end requires tickets submitted into the private backlog that declare a configured provider's canonical SSH URL, SSH push authorization to that repository, that provider's credential, and the backlog configuration.

The recovery sample projects and recovery ticket remain as samples, but they are not proof scenarios. This runner does not provide the removed factory engine's bounded-recovery policy, protected acceptance-test machinery, publication contract, PR artifact, or engine report guarantees.

## Retained surfaces

- `factory/`: the backlog-driven runner implementation and its submission client (see "Runner implementation")
- `.env.example`: the `FORGE_BACKLOG_REPOSITORY`, `FORGE_BACKLOG_PROJECT_ID`, `FORGE_BACKLOG_TOKEN`, `GITHUB_TOKEN`, and `AZURE_DEVOPS_PAT` template at the repository root
- `samples/`: independent .NET fixture projects and Markdown tickets
- `factory/infrastructure/agent-runtime/skills/`: read-only agent skills and companion material
- `proof/scenarios/`: five minimal scenario mappings
- `proof/harness/materialize-fixture.ts`: disposable repository preparation
- `proof/harness/evaluate.ts`: standalone evaluator dispatch
- `proof/evaluators/`: five independent evaluators and `StructureEvaluator`
- `proof/harness/fulfillment_routing_stub.py`: allocation evaluator dependency
- `proof/expected/`: five evaluator positive controls

The old custom factory engine (packages, applications, stage/recovery harness, engine tests, and configuration), the earlier `.sandcastle/` monolith, the merge agent, and the global target-repository (`--repo`) workflow are not part of this runner.
