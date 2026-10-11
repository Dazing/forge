# Forge - A software development factory

This repository adapts Matt Pocock's Sandcastle runner for dependency-aware local Markdown tickets. Tickets execute in fresh retained Git workspaces; agents implement, review, and resolve integrations without committing. TypeScript owns implementation/review checkpoints, reviewed multi-parent integration commits, safe pushes, and draft pull-request creation or extension. Connected dependency groups normally produce one combined reviewed draft, while failed combinations fall back to dependency-closed reviewed subsets.

The runner uses `@ai-hero/sandcastle@0.12.0`, Pi `1.1.0`, oh-my-pi `18.8.4`, and the OpenAI-compatible model ID `vllm-qwen38-27b` at `https://openai.taila49adb.ts.net/v1`. It runs continuously, sleeps 10 seconds only when no tickets are pending, and bounds all agent jobs with `--max-parallel` (default `1`).

## Prerequisites

- Node.js 24 and npm 11
- Git
- Docker
- .NET SDK 10 and Python 3 for running the standalone evaluators on the host
- Host Tailscale connectivity to `https://openai.taila49adb.ts.net/v1`
- Provider access for the ticket repository, selected by `GIT_PROVIDER` in the repository-root `.env` (one provider per invocation, so every ticket in that invocation uses that provider's canonical SSH URL):
  - `GIT_PROVIDER=github` — SSH authorization to push `git@github.com:<owner>/<repository>.git` from the host (the runner runs `git push` on the host, so the host's SSH key/agent must be authorized on the account), plus `GITHUB_TOKEN`: a fine-grained personal access token with **Metadata: Read** and **Pull requests: Write** on the target repository;
  - `GIT_PROVIDER=azure-devops` — SSH authorization to push `git@ssh.dev.azure.com:v3/<organization>/<project>/<repository>` from the host, plus `AZURE_DEVOPS_PAT`: a personal access token scoped to **Code: Read & write** (`vso.code_write`).

In both cases SSH push authorization is independent from the REST credential used to create draft pull requests.

`GIT_PROVIDER` and the provider credential are read from the repository-root `.env` via `process.loadEnvFile`, which is gitignored. Copy `.env.example` and fill in the provider and its credential:

```bash
cp .env.example .env
```

A missing repository-root `.env`, an unsupported `GIT_PROVIDER`, or a blank provider credential is a fatal startup failure before the runner polls any ticket. `npm run sandcastle -- --help` prints runner help without requiring Docker, credentials, or the token.

Install dependencies and build the runner image:

```bash
npm install
npx sandcastle docker build-image \
  --image-name local-sandcastle-runner:latest \
  --dockerfile factory/infrastructure/sandbox/Dockerfile
```

The container uses host networking so the agent can resolve the tailnet hostname and use the host's Tailscale routes. `factory/infrastructure/agent-runtime/models.json` defines the `local-vllm` provider and is mounted read-only at `~/.pi/agent/models.json` for Pi or `~/.omp/agent/models.yml` for oh-my-pi (JSON is valid YAML); no Anthropic or OpenAI API credential is required for this local service. The catalog at `factory/infrastructure/agent-runtime/skills/` is mounted read-only at the selected harness's global skills directory, `~/.pi/agent/skills/` or `~/.omp/agent/skills/`.

## Running

Create a ticket directory outside `.workspaces/` and add one or more root-level Markdown tickets:

```bash
mkdir -p ticket-queue
```

Every ticket must start with strict YAML front matter:

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

For `GIT_PROVIDER=azure-devops`, the repository is the Azure SSH form:

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
- `repository` must be the canonical SSH URL of the selected provider: `git@github.com:<owner>/<repository>.git` for GitHub, `git@ssh.dev.azure.com:v3/<organization>/<project>/<repository>` for Azure DevOps. HTTPS, local-path, legacy `ssh.visualstudio.com`, GitHub Enterprise, and cross-provider URLs are rejected.
- `id` is required, stable, case-sensitive, and must not contain whitespace or control characters. `dependsOnTickets` defaults to `[]`; duplicate/self references are rejected. Missing references remain blocked until the ticket arrives. Cycles and repository/base-branch mismatches reject graph execution.
- `baseBranch` is optional and defaults to `main`. Every connected dependency group uses one canonical repository and base branch.
- `sourceHash` covers the complete source. `requirementsHash` deterministically covers authored front matter/body while excluding only structurally recognized factory records. Annotation-only changes preserve reusable checkpoints; authored changes after a successful checkpoint block the ID and descendants until the author supplies a new ID.

Start the daemon from this repository:

```bash
npm run factory -- --tickets-dir ./.ticket-queue \
  --max-parallel 1 \
  --ticket-attempts-per-cycle 3
```

Pi is the default harness; pass `--agent-harness oh-my-pi` when required. Both numeric options require positive integers and are validated before environment, credential, or sandbox work. `--max-parallel` is invocation-global across implementation, review, integration, and pull-request content jobs. `--ticket-attempts-per-cycle` controls fresh complete attempts; the default is `3`.

The daemon scans sorted root-level Markdown files and plans at most one validated connected delivery group per cycle. Within that group, every dependency-ready ticket can run concurrently within the global limit. Planning remains serialized. Empty planner selections and retryable pending work add no backoff; only an empty active queue sleeps for 10 seconds.

### Dependency-group lifecycle

1. Validate declared IDs, references, cycles, and repository/base compatibility. Missing references and descendants of unsuccessful work remain nonterminally blocked.
2. Run dependency-ready tickets in isolated fresh workspaces. Roots start at the refreshed canonical base; a one-parent ticket imports the parent's clean review checkpoint; multi-parent tickets wait for a runner-owned reviewed integration baseline. Siblings never see one another's ticket-specific changes.
3. Each complete attempt runs implementation and review through their existing three single-iteration stage loops. Every successful stage receives exactly one runner-owned checkpoint, including an empty review checkpoint. A failed complete attempt is retained and retried in a fresh workspace from the same pinned dependency baseline, up to the cycle budget.
4. Exhausted tickets remain retryable for the next cycle. Descendants stay blocked; successful ancestors and independent siblings remain reusable and publishable.
5. After runnable work settles, reviewed leaf candidates are merged in stable ticket-ID order in a fresh integration workspace. The integration agent resolves conflicts and reviews the combined behavior but never commits; the runner validates parents, conflict dispositions, index/tree cleanliness, and creates the merge commit. Combined review runs even for clean Git merges.
6. Publish only dependency-closed reviewed candidates. A failed combined review never publishes its tree; independently reviewed subsets may publish separately. Pull-request content lists included, retryable, blocked, integration-excluded tickets, and every conflict disposition.
7. A tracked unchanged open draft may be extended only after provider identity, refs, source SHA, title/body, draft state, and squash preference match invocation memory. The push is non-force and the provider is reread after an uncertain update. Closed, non-draft, missing, or externally changed drafts are untouched; reviewed work uses a fresh draft.
8. Store publication facts before guarded completion annotation/movement, so settlement failures never republish. Only included tickets move to `done/`; retryable/blocked source tickets remain active.

Fresh workspaces and failed integrations are retained. The runner never resets, cleans, amends, rebases, force-pushes, merges a pull request, enables auto-merge, bypasses policy, deletes branches, or rewrites repository settings.

Continuation is invocation-only. Startup inspects active and lifecycle ticket evidence; prior attempts/checkpoints/publications block affected IDs for operator reconciliation instead of reconstructing or republishing old state. Unrelated fresh groups continue. When a tracked partial PR is merged, the runner refreshes the base, requires a provider merge-result SHA reachable from it, applies the exact recorded published delta to the merge result's first parent in a disposable worktree, and compares trees. Verified IDs become satisfied on the refreshed base; inconclusive evidence blocks affected descendants without replaying retained history.

The provider credential is passed explicitly to the logger, ticket annotations, and provider, and every literal occurrence is replaced with `[redacted-token]` before it reaches a log, ticket file, or command display. For Azure DevOps the encoded Basic authorization value derived from the PAT is redacted as well. The credential never appears in Git arguments, URLs, logs, ticket diagnostics, or agent environments.

When an agent runs in the factory checkout, the sandbox overlays its repository-root `.env` with the read-only empty `factory/infrastructure/sandbox/masked.env` asset. This keeps the planner from reading the host's REST credentials without changing the host file or factory snapshot semantics. Agents running in ticket workspaces retain their own repositories' application configuration.

### Merge method preference

The runner requests squash merge as a preference only. It never merges, marks a pull request ready, bypasses provider policy, deletes the source branch, or rewrites repository settings, and pull requests stay draft.

- **Azure DevOps**: the REST `7.1` create request carries `completionOptions` with `mergeStrategy: "squash"`, `isDraft: true`, `deleteSourceBranch: false`, and `bypassPolicy: false`, and no `autoCompleteSetBy`. The response's draft state and persisted merge strategy are validated; when the create response omits `completionOptions`, one read-back GET resolves it. Read-back must have a successful HTTP status, the same pull-request ID, draft state, and the requested squash strategy. Read-back HTTP, transport, malformed-response, identity, draft, and strategy failures retain the pushed branch and any created PR; structured diagnostics preserve the failure explanation and known browser-facing PR URL while redacting the raw PAT and derived Basic value. The provider reports `squashPreference: "configured"` only after validation.
- **GitHub**: the REST API has no per-pull-request merge-method field, so the create payload carries none. The provider reports `squashPreference: "unsupported"`, the pull-request body gets a short runner-owned note asking the reviewer to select squash when merging (within the existing 5000-character body limit), and the limitation is recorded in the completion annotation. No GraphQL auto-merge, ready-to-merge, merge endpoint, or repository-settings call is made.

The persisted preference is appended to the ticket's completion section as `- Merge method: squash (configured|unsupported)`.

### Logs

Agent output is written under `.logs/<run timestamp>-<process ID>/` at the root of this runner checkout. Each planner, implementer, reviewer, and pull-request stage gets a separate human-readable progress log containing assistant text and concise tool-start summaries while omitting raw Pi events such as thinking blocks and tool output. The same directory holds `main.log`, the append-only record of ticket attempts and failures.

Each successful checkpoint appends one line to `main.log` in the form `timestamp ticket=<id> attempt=<id> stage=<stage> operation=creating stage checkpoint commit status=completed parent=<sha> checkpoint=<sha> changes=<changed|unchanged> agent-log=<basename>.log`. Trace a stage from the log to its commit and its agent transcript:

```bash
grep 'stage=review commit' .logs/*/main.log            # boundary records with parent/checkpoint SHAs
git -C .workspaces/<slug>-<attempt-id> show <checkpoint-sha>   # message plus Factory-* trailers
git -C .workspaces/<slug>-<attempt-id> diff <parent-sha> <checkpoint-sha>   # the stage delta
cat .logs/<run timestamp>-<process ID>/review-<ticket-id>-<attempt-id>.log  # the stage transcript
```

## Runner implementation

The runner is the `factory/` tree, split by responsibility:

- `factory/main.ts` — thin composition root: parse flags, load the repository-root `.env`, select the provider from `GIT_PROVIDER` and its credential, validate the ticket directory, create the invocation logger, run the sandbox preflight, build the agent runner, and start the ticket-processing daemon.
- `factory/cli/cli.ts` — `--tickets-dir`, harness selection, `--max-parallel`, `--ticket-attempts-per-cycle`, validation, and help-first startup behavior.
- `factory/features/tickets/` — declared identity/dependencies, source and authored-requirements fingerprints, active/lifecycle discovery, append-only attempt/checkpoint/retryable/blocked/publication/completion/failure records, evidence inspection, and guarded movement.
- `factory/features/plan-tickets/` — immutable factory-checkout planning for exact validated delivery-group IDs and member ID/title records. Execution capacity remains coordinator policy.
- `factory/features/implement-ticket/` and `review-ticket/` — stage-owned loops of up to three single-iteration agent runs, structured messages, branch/HEAD contracts, and no agent commits. Implementation receives the pinned reviewed dependency context.
- `factory/features/integrate-tickets/` — conflict resolution and combined review for pending runner-created merges, with three repair runs, structured conflict dispositions, branch/HEAD protection, unresolved-entry checks, and conflict-marker rejection.
- `factory/features/publish-pull-request/` — read-only grouped content, immutable entry trace, commit-count/net-change gates, final SHA, safe non-force create/extension push, draft creation/update, uncertain-update reread, included/retryable/blocked/excluded/conflict evidence, and bounded GitHub squash note.
- `factory/features/ticket-processing/` — invocation graph/component state, global agent leases, dependency-ready scheduling, fresh complete retries, dependency checkpoint import, multi-parent integration, reviewed-subset fallback, publication/settlement separation, startup evidence blocks, requirements guards, and merged-delta reconciliation.
- `factory/infrastructure/git-provider/` — provider-neutral create/read/update contracts and Git mechanisms. GitHub and Azure DevOps return canonical PR state, refs, source SHA, title/body, draft status, squash capability, and merge-result SHA while preserving structured credential-redacted failures.
- `factory/infrastructure/logging/` — `invocation-log.ts` (run directory, agent log paths, redacted `main.log`).
- `factory/infrastructure/sandbox/` — `sandbox.ts` (host-network Docker provider, native read-only skill/model mounts, factory credential masking, preflight), `masked.env` (empty credential overlay), `Dockerfile` (Pi 1.1.0, oh-my-pi 18.8.4, RoslynMcp 1.2.3, .NET 10 runtime), and `check-mcp.mjs` (Pi MCP preflight).
- `factory/infrastructure/agent-runtime/` — `agent-runtime.ts` (generic configured agent execution: sandbox provider, file logging, prompt file, completion signal, structured output, iteration limits), `create-agent.ts`, `stream-events.ts`, `oh-my-pi.ts`, `models.json` with `models-path.ts`, and the read-only `skills/` catalog.
- `factory/shared/` — `paths.ts`, `sleep.ts`, and `redact-secret.ts`.

The planner returns at most one exact validated delivery group and cannot bypass graph readiness. Implement, review, and integration own their structured single-iteration repair loops; agents never commit. The runner owns every checkpoint and integration commit. Planning/graph contract failures are invocation-fatal; unsuccessful complete attempts remain retryable, while durable-boundary failures require reconciliation.

## Tests

```bash
npm test          # tsx --test "factory/**/*.test.ts"
npm run typecheck
npm run check:architecture   # dependency-cruiser rules in .dependency-cruiser.cjs
npm run verify    # typecheck + tests + architecture check
```

The architecture is enforced by dependency-cruiser rules in `.dependency-cruiser.cjs`:

- A feature may enter another feature only through its `index.ts`; deep imports of internal modules are rejected.
- The stage features (`plan-tickets`, `implement-ticket`, `review-ticket`, `integrate-tickets`, `publish-pull-request`) never import `ticket-processing` or each other; `ticket-processing` composes them.
- `tickets` is a leaf: it imports no other feature.
- Infrastructure (`agent-runtime`, `sandbox`, `git-provider`, `logging`) never imports features, `main.ts`, or `cli/`; `shared/` never imports features or infrastructure; features never import `main.ts` or `cli/`.
- Unresolvable local imports and circular dependencies are rejected.

The skills catalog under `factory/infrastructure/agent-runtime/skills/` is excluded from the cruise: its files are read-only agent material, not production modules.

Automated coverage includes identity/fingerprint boundaries, graph chains/diamonds/missing references/invalid edges, numeric configuration, real-Git dependency baselines and sibling isolation, bounded sibling overlap, fresh retry isolation, next-cycle continuation with safe draft extension, conflict resolution evidence, reviewed-subset fallback, included-only settlement, squash-equivalent merged-delta verification and mismatch rejection, lifecycle records, runner-owned checkpoints, provider create/read/update requests, credential redaction, publication gates, and architecture boundaries. Provider HTTP is exercised through controlled fetch seams; live SSH/provider writes still require an authorized disposable remote.

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

The sample tickets have no YAML front matter and target no provider repository, and the materialized fixtures are local paths. Proof fixtures and evaluators verify code quality in materialized local repositories; they are **not** an end-to-end remote-publication smoke path. Running the daemon end to end requires tickets that declare the selected provider's canonical SSH URL, SSH push authorization, and that provider's credential.

The recovery sample projects and recovery ticket remain as samples, but they are not proof scenarios. This runner does not provide the removed factory engine's bounded-recovery policy, protected acceptance-test machinery, publication contract, PR artifact, or engine report guarantees.

## Retained surfaces

- `factory/`: the local-ticket runner implementation (see "Runner implementation")
- `.env.example`: the `GIT_PROVIDER`, `GITHUB_TOKEN`, and `AZURE_DEVOPS_PAT` template at the repository root
- `samples/`: independent .NET fixture projects and Markdown tickets
- `factory/infrastructure/agent-runtime/skills/`: read-only agent skills and companion material
- `proof/scenarios/`: five minimal scenario mappings
- `proof/harness/materialize-fixture.ts`: disposable repository preparation
- `proof/harness/evaluate.ts`: standalone evaluator dispatch
- `proof/evaluators/`: five independent evaluators and `StructureEvaluator`
- `proof/harness/fulfillment_routing_stub.py`: allocation evaluator dependency
- `proof/expected/`: five evaluator positive controls

The old custom factory engine (packages, applications, stage/recovery harness, engine tests, and configuration), the earlier `.sandcastle/` monolith, the merge agent, and the global target-repository (`--repo`) workflow are not part of this runner.
