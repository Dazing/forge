# Local Sandcastle runner

This repository adapts Matt Pocock's Sandcastle runner for local Markdown tickets. Each selected ticket owns one fresh, retained Git workspace: the runner clones the ticket's own repository, the agents implement and review inside that workspace and create local commits, and TypeScript performs the commit-count check, push, and draft pull request on the configured provider. Tickets, skills, evaluators, and expected solutions remain in this source checkout. The runner is implemented in `factory/`; the earlier `.sandcastle/` monolith is not part of this runner.

The runner uses `@ai-hero/sandcastle@0.12.0`, Pi `1.1.0`, oh-my-pi `18.8.4`, and the OpenAI-compatible model ID `vllm-qwen38-27b` at `https://openai.taila49adb.ts.net/v1`. It runs continuously as a daemon, sleeps 10 seconds when no tickets are pending, and selects at most `MAX_PARALLEL = 1` ticket per planning iteration.

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
name: fix-login-redirect
repository: git@github.com:acme/app.git
baseBranch: main
---

# Fix login redirect

Body of the ticket...
```

For `GIT_PROVIDER=azure-devops`, the repository is the Azure SSH form:

```markdown
---
name: fix-login-redirect
repository: git@ssh.dev.azure.com:v3/Contoso Team/Web App/fix-login
baseBranch: release/2.1
---
```

- `name` is normalized once into a lowercase ASCII kebab-case slug. The slug must not be empty.
- `repository` must be the canonical SSH URL of the selected provider: `git@github.com:<owner>/<repository>.git` for GitHub, `git@ssh.dev.azure.com:v3/<organization>/<project>/<repository>` for Azure DevOps. HTTPS, local-path, legacy `ssh.visualstudio.com`, GitHub Enterprise, and cross-provider URLs are rejected.
- `baseBranch` is optional and defaults to `main`. The branch must exist in the remote repository.
- The ticket ID is the first 16 hexadecimal characters of the SHA-256 hash of the complete ticket source. The title is the first Markdown H1 in the body, falling back to the slug. IDs are not provider issue numbers; the runner never queries or closes external issues.

Start the daemon from this repository:

```bash
npm run sandcastle -- --tickets-dir ./ticket-queue
```

Pi is the default agent harness. Select oh-my-pi explicitly when needed:

```bash
npm run sandcastle -- --tickets-dir ./ticket-queue --agent-harness oh-my-pi
```

The ticket directory must already exist. The selected harness is used for every stage, including planning. The daemon scans root-level `*.md` files in sorted order and plans at most one ticket per iteration. It sleeps 10 seconds only when no tickets are pending; an empty planner selection with pending tickets does not add a delay. It runs until interrupted. Files under the lifecycle subdirectories are not polled.

Tickets with missing or invalid front matter receive a metadata failure annotation and move to `<tickets-dir>/failed/`; the daemon continues polling.

### Per-ticket lifecycle

For every planned ticket the runner:

1. Generates a six-hex attempt ID, reserves `.workspaces/<slug>-<attempt-id>/`, and appends the workspace, branch, repository, and base branch to the ticket.
2. Validates `baseBranch`, performs a fresh non-shallow `--single-branch` clone of that branch, and checks out `agent-tickets/<slug>-<attempt-id>`. It does not run repository-specific install, restore, build, or bootstrap commands before the agents start.
3. Runs the implementer and reviewer in that workspace for up to three iterations each. Agents may inspect Git and create local commits, but cannot push, mutate remote branches, invoke `gh` or `az repos`, or call the GitHub or Azure DevOps API. The runner requires a completely clean index and worktree after review, including generated and untracked files.
4. Runs the read-only pull-request agent to produce a title and body. The runner rejects any commit or worktree mutation made during this stage.
5. Requires at least one existing agent commit ahead of `origin/<baseBranch>`, pushes `agent-tickets/<slug>-<attempt-id>` through SSH, and creates a draft pull request against `baseBranch` through the selected provider's REST API.
6. Appends the retained workspace, branch, base branch, final commit SHA, and draft PR URL to the ticket, then moves it to `<tickets-dir>/done/`.

Every workspace is retained on success and failure. If push succeeds but draft-PR creation fails, the remote branch is also retained; the runner performs no rollback or remote deletion.

A ticket-level setup, agent, finalization, push, or pull-request failure is written once to `main.log`, appended to the ticket with its stage, sanitized operation, exit code or HTTP status, stdout, and stderr, and moved to `<tickets-dir>/failed/`. That failure does not stop the daemon. Startup, ticket-directory read, and planner failures remain invocation-fatal.

The provider credential is passed explicitly to the logger, ticket annotations, and provider, and every literal occurrence is replaced with `[redacted-token]` before it reaches a log, ticket file, or command display. For Azure DevOps the encoded Basic authorization value derived from the PAT is redacted as well. The credential never appears in Git arguments, URLs, logs, ticket diagnostics, or agent environments.

When an agent runs in the factory checkout, the sandbox overlays its repository-root `.env` with the read-only empty `factory/infrastructure/sandbox/masked.env` asset. This keeps the planner from reading the host's REST credentials without changing the host file or factory snapshot semantics. Agents running in ticket workspaces retain their own repositories' application configuration.

### Logs

Agent output is written under `.logs/<run timestamp>-<process ID>/` at the root of this runner checkout. Each planner, implementer, reviewer, and pull-request stage gets a separate human-readable progress log containing assistant text and concise tool-start summaries while omitting raw Pi events such as thinking blocks and tool output. The same directory holds `main.log`, the append-only record of ticket attempts and failures.

## Runner implementation

The runner is the `factory/` tree, split by responsibility:

- `factory/main.ts` — thin composition root: parse flags, load the repository-root `.env`, select the provider from `GIT_PROVIDER` and its credential, validate the ticket directory, create the invocation logger, run the sandbox preflight, build the agent runner, and start the ticket-processing daemon.
- `factory/cli/cli.ts` — flag parsing for `--tickets-dir`, `--agent-harness` (`pi` default, `pi`/`oh-my-pi`), and `--help`.
- `factory/features/tickets/` — `ticket.ts` (front-matter parsing, slug/ID/title derivation, provider repository validation), `ticket-files.ts` (ticket-directory scanning), and `ticket-lifecycle.ts` (attempt, completion, and failure annotations plus terminal movement into `done/`/`failed/`). Cross-feature entry is `index.ts`.
- `factory/features/plan-tickets/` — one planning iteration: `plan-schema.ts` (`MAX_PARALLEL = 1`, `validatePlan`), `plan-tickets.ts` (planner run and the factory-checkout snapshot check that rejects planner commits/worktree changes), and `plan-prompt.md`.
- `factory/features/implement-ticket/` — bounded implementer run with the completion signal as the success condition, and `implement-prompt.md`.
- `factory/features/review-ticket/` — bounded reviewer run plus the clean-workspace postcondition that gates publication, and `review-prompt.md`.
- `factory/features/publish-pull-request/` — read-only pull-request content stage, commit-count check, final SHA, push, and draft pull-request creation; `PublicationError` carries the failing substage for settlement, and `pull-request-schema.ts` bounds the title/body.
- `factory/features/ticket-processing/` — the daemon loop (10-second sleep when nothing is pending), one bounded iteration (discovery, planning, attempts, terminal bookkeeping), per-attempt execution (reserve, workspace, implement, review, publish, terminal transition), and failure settlement into `failed/`.
- `factory/infrastructure/git-provider/` — `git-provider.ts` (the provider contract: credential, repository validation, draft pull-request creation), `create-git-provider.ts` (provider selection from `GIT_PROVIDER`), `github-provider.ts` and `azure-devops-provider.ts` (REST publication with structured HTTP failures, no Octokit, no `gh`, no `az`), and `git.ts` (argv-based command runner with structured `CommandFailure`, repository snapshots, and cleanliness checks).
- `factory/infrastructure/logging/` — `invocation-log.ts` (run directory, agent log paths, redacted `main.log`).
- `factory/infrastructure/sandbox/` — `sandbox.ts` (host-network Docker provider, native read-only skill/model mounts, factory credential masking, preflight), `masked.env` (empty credential overlay), `Dockerfile` (Pi 1.1.0, oh-my-pi 18.8.4, RoslynMcp 1.2.3, .NET 10 runtime), and `check-mcp.mjs` (Pi MCP preflight).
- `factory/infrastructure/agent-runtime/` — `agent-runtime.ts` (generic configured agent execution: sandbox provider, file logging, prompt file, completion signal, structured output, iteration limits), `create-agent.ts`, `stream-events.ts`, `oh-my-pi.ts`, `models.json` with `models-path.ts`, and the read-only `skills/` catalog.
- `factory/shared/` — `paths.ts`, `sleep.ts`, and `redact-secret.ts`.

The planner is read-only and returns a `<plan>` JSON selection by ticket ID/title only; it must complete with `</plan>`. The implementer and reviewer may continue for up to three iterations but must emit `<promise>COMPLETE</promise>`; after review, the runner independently rejects any uncommitted tracked, generated, or untracked files. The pull-request agent returns content in `<pull-request>` tags and must also emit `<promise>COMPLETE</promise>`. Planner failures are invocation-fatal. Implementation, review, and publication failures settle the ticket attempt; publication snapshot failures retain the `pull-request content` substage and original Git diagnostics.

## Tests

```bash
npm test          # tsx --test "factory/**/*.test.ts"
npm run typecheck
npm run check:architecture   # dependency-cruiser rules in .dependency-cruiser.cjs
npm run verify    # typecheck + tests + architecture check
```

The architecture is enforced by dependency-cruiser rules in `.dependency-cruiser.cjs`:

- A feature may enter another feature only through its `index.ts`; deep imports of internal modules are rejected.
- The stage features (`plan-tickets`, `implement-ticket`, `review-ticket`, `publish-pull-request`) never import `ticket-processing` or each other; `ticket-processing` composes them.
- `tickets` is a leaf: it imports no other feature.
- Infrastructure (`agent-runtime`, `sandbox`, `git-provider`, `logging`) never imports features, `main.ts`, or `cli/`; `shared/` never imports features or infrastructure; features never import `main.ts` or `cli/`.
- Unresolvable local imports and circular dependencies are rejected.

The skills catalog under `factory/infrastructure/agent-runtime/skills/` is excluded from the cruise: its files are read-only agent material, not production modules.

Ticket parsing, provider selection, provider repository validation, provider request construction, provider failure and redaction behavior, lifecycle annotations, workspace creation (real Git fixtures), and the fetch seam are covered. The live publication paths (GitHub SSH push plus REST draft pull request, Azure DevOps SSH push plus REST draft pull request) are not exercised by automated tests: they require disposable provider credentials, so end-to-end publication is verified by running the daemon against a real repository.

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
