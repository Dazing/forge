# Local Sandcastle runner

This repository adapts Matt Pocock's Sandcastle runner for local Markdown tickets. Each selected ticket owns one fresh, retained Git workspace: the runner clones the ticket's own GitHub repository, the agents implement and review inside that workspace, and TypeScript performs the commit, push, and GitHub draft pull request. Tickets, skills, evaluators, and expected solutions remain in this source checkout. The runner is implemented in `factory/`; the earlier `.sandcastle/` monolith is not part of this runner.

The runner uses `@ai-hero/sandcastle@0.12.0`, Pi `1.1.0`, oh-my-pi `18.8.4`, and the OpenAI-compatible model ID `vllm-qwen38-27b` at `https://openai.taila49adb.ts.net/v1`. It runs continuously as a daemon, polls the ticket directory every 10 seconds, and selects at most `MAX_PARALLEL = 1` ticket per planning iteration.

## Prerequisites

- Node.js 24 and npm 11
- Git
- Docker
- .NET SDK 10 and Python 3 for running the standalone evaluators on the host
- Host Tailscale connectivity to `https://openai.taila49adb.ts.net/v1`
- GitHub.com access for the ticket repository:
  - SSH authorization to push `git@github.com:<owner>/<repo>.git` from the host (the runner runs `git push` on the host, so the host's SSH key/agent must be authorized on the account);
  - a fine-grained personal access token with **Metadata: Read** and **Pull requests: Write** on the target repository (the token creates draft pull requests only; it cannot authorize SSH pushes).

`GITHUB_TOKEN` is read from the repository-root `.env` via `process.loadEnvFile`, which is gitignored. Copy `.env.example` and fill in the token:

```bash
cp .env.example .env
```

A missing repository-root `.env` or a blank `GITHUB_TOKEN` is a fatal startup failure before the runner polls any ticket. `npm run sandcastle -- --help` prints runner help without requiring Docker, credentials, or the token.

Install dependencies and build the runner image:

```bash
npm install
npx sandcastle docker build-image \
  --image-name local-sandcastle-runner:latest \
  --dockerfile factory/sandbox/Dockerfile
```

The container uses host networking so the agent can resolve the tailnet hostname and use the host's Tailscale routes. `factory/harness/models.json` defines the `local-vllm` provider and is mounted read-only into the agent's directory (`models.json` for Pi, `models.yml` for oh-my-pi); no Anthropic or OpenAI API credential is required for this local service.

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

- `name` is normalized once into a lowercase ASCII kebab-case slug. The slug must not be empty.
- `repository` must have the exact GitHub SSH form `git@github.com:<owner>/<repository>.git`; HTTPS, local-path, GitHub Enterprise, and other-provider repositories are rejected.
- `baseBranch` is optional and defaults to `main`. The branch must exist in the remote repository.
- The ticket ID is the first 16 hexadecimal characters of the SHA-256 hash of the complete ticket source. The title is the first Markdown H1 in the body, falling back to the slug. IDs are not GitHub issue numbers; the runner never queries or closes external issues.

Start the daemon from this repository:

```bash
npm run sandcastle -- --tickets-dir ./ticket-queue
```

Pi is the default agent harness. Select oh-my-pi explicitly when needed:

```bash
npm run sandcastle -- --tickets-dir ./ticket-queue --agent-harness oh-my-pi
```

The ticket directory must already exist. The daemon polls its root-level `*.md` files in sorted order every 10 seconds and plans at most one ticket per iteration. It runs until interrupted. Files under the lifecycle subdirectories are not polled.

Tickets with missing or invalid front matter receive a metadata failure annotation and move to `<tickets-dir>/failed/`; the daemon continues polling.

### Per-ticket lifecycle

For every planned ticket the runner:

1. Generates a six-hex attempt ID, reserves `.workspaces/<slug>-<attempt-id>/`, and appends the workspace, branch, repository, and base branch to the ticket.
2. Validates `baseBranch`, performs a fresh non-shallow `--single-branch` clone of that branch, and checks out `agent-tickets/<slug>-<attempt-id>`. It does not run repository-specific install, restore, build, or bootstrap commands before the agents start.
3. Runs the implementer and reviewer in that workspace for up to three iterations each. Agents may inspect Git and create local commits, but cannot push, mutate remote branches, invoke `gh`, or call the GitHub API. The runner requires a completely clean index and worktree after review, including generated and untracked files.
4. Runs the read-only pull-request agent to produce a title and body. The runner rejects any commit or worktree mutation made during this stage.
5. Requires at least one existing agent commit ahead of `origin/<baseBranch>`, pushes `agent-tickets/<slug>-<attempt-id>` through SSH, and creates a draft pull request against `baseBranch` through the GitHub REST API.
6. Appends the retained workspace, branch, base branch, final commit SHA, and draft PR URL to the ticket, then moves it to `<tickets-dir>/done/`.

Every workspace is retained on success and failure. If push succeeds but draft-PR creation fails, the remote branch is also retained; the runner performs no rollback or remote deletion.

A ticket-level setup, agent, finalization, push, or pull-request failure is written once to `main.log`, appended to the ticket with its stage, sanitized operation, exit code or HTTP status, stdout, and stderr, and moved to `<tickets-dir>/failed/`. That failure does not stop the daemon. Startup, ticket-directory read, and planner failures remain invocation-fatal.

The GitHub token is passed explicitly to the logger, ticket annotations, and pull-request service, and every literal occurrence is replaced with `[redacted-token]` before it reaches a log, ticket file, or command display. The token never appears in Git arguments, URLs, logs, ticket diagnostics, or agent environments.

### Logs

Agent output is written under `.logs/<run timestamp>-<process ID>/` at the root of this runner checkout. Each planner, implementer, reviewer, and pull-request stage gets a separate human-readable progress log containing assistant text and concise tool-start summaries while omitting raw Pi events such as thinking blocks and tool output. The same directory holds `main.log`, the append-only record of ticket attempts and failures.

## Runner implementation

The runner is the `factory/` tree, split by responsibility:

- `factory/main.ts` — composition root and daemon main loop: parse flags, load the repository-root `.env`, require `GITHUB_TOKEN`, validate the ticket directory, create the invocation logger, run the sandbox preflight, load each ticket file (metadata failures are settled into `failed/`), then loop forever, sleeping 10 seconds when nothing is pending.
- `factory/cli/cli.ts` — flag parsing for `--tickets-dir`, `--agent-harness` (`pi` default, `pi`/`oh-my-pi`), and `--help`.
- `factory/orchestration/ticket-orchestrator.ts` — one planning iteration: run the planner, reject planner commits/worktree changes in the factory checkout, then run each planned ticket attempt (workspace, implement, review, pull-request content, commit, commit-count check, push, draft pull request, terminal ticket transition) with per-attempt failure settlement.
- `factory/tickets/tickets.ts` — front-matter parsing, slug/ID/title derivation, ticket-directory scanning, `formatTickets`, the `planSchema` (`MAX_PARALLEL = 1`), and `validatePlan`.
- `factory/tickets/ticket-lifecycle.ts` — attempt, completion, and failure annotations (fenced command output, token redaction) and terminal ticket movement into `done/`/`failed/`.
- `factory/workspace/workspace-service.ts` — attempt-ID generation, workspace reservation, base-branch validation, fresh single-branch clone, ticket branch checkout, and postcondition checks.
- `factory/github/pull-request-service.ts` — draft pull request creation through the GitHub REST API with structured HTTP failures (no Octokit, no `gh`).
- `factory/shared/` — `git.ts` (argv-based command runner with structured `CommandFailure`), `invocation-log.ts` (run directory, agent log paths, redacted `main.log`), `paths.ts`, and `sleep.ts`.
- `factory/sandbox/` — `sandbox.ts` (Docker provider, read-only skill/model mounts, preflight), `Dockerfile` (Pi 1.1.0, oh-my-pi 18.8.4, RoslynMcp 1.2.3, .NET 10 runtime), and `check-mcp.mjs` (Pi MCP preflight).
- `factory/harness/` — `harness-agents.ts` (agent construction, the four stage runs, bounded three-iteration implementation/review recovery, conditional MCP guidance, tool-summary logging, completion signals, and the pull-request output schema), `oh-my-pi.ts`, and `models.json`.
- `factory/prompts/` — the plan, implement, review, and pull-request prompts.

The planner is read-only and returns a `<plan>` JSON selection by ticket ID/title only. The implementer and reviewer may continue for up to three iterations but must emit the clean completion signal; after review, the runner independently rejects any uncommitted tracked, generated, or untracked files. The pull-request agent returns content only. Any stage that fails its completion signal, violates workspace cleanliness or read-only constraints, mutates the workspace during the content stage, or fails a Git/API check fails that ticket attempt.

## Tests

```bash
npm test          # tsx --test "factory/**/*.test.ts"
npm run typecheck
```

Ticket parsing, lifecycle annotations, workspace creation (real Git fixtures), and the pull-request service (fetch seam) are covered. The live GitHub publication path (SSH push plus REST draft pull request) is not exercised by automated tests: it requires disposable GitHub credentials, so end-to-end publication is verified by running the daemon against a real repository.

## Proof scenarios

The five retained proof modes map fixtures to host-side tickets, skills, evaluators, and expected-solution positive controls:

| Mode | Scenario | Fixture | Ticket |
|---|---|---|---|
| Feature | `proof/scenarios/feature.json` | `samples/feature` | `samples/tickets/feature.md` |
| Bug | `proof/scenarios/bug.json` | `samples/bug` | `samples/tickets/bug.md` |
| Refactor | `proof/scenarios/refactor.json` | `samples/refactor` | `samples/tickets/refactor.md` |
| VSA feature | `proof/scenarios/vsa-feature.json` | `samples/vsa-feature` | `samples/tickets/vsa-feature.md` |
| VSA allocation | `proof/scenarios/vsa-allocation-feature.json` | `samples/vsa-allocation-feature` | `samples/tickets/vsa-allocation-feature.md` |

Preparation creates a timestamped repository under `.run/`, copies only the selected fixture, and initializes that copy as a new Git repository:

```bash
RUN_PATH=$(npm run --silent prepare:scenario -- proof/scenarios/vsa-allocation-feature.json)
npm run evaluate -- proof/scenarios/vsa-allocation-feature.json "$RUN_PATH"
```

`npm run evaluate -- <scenario.json> <candidate-repository>` invokes the scenario's independent evaluator and returns its pass/fail status. Expected solutions under `proof/expected/` are evaluator positive controls only; neither they nor `proof/evaluators/` are copied into an agent repository.

The sample tickets have no YAML front matter and target no GitHub repository, and the materialized fixtures are local paths. Proof fixtures and evaluators verify code quality in materialized local repositories; they are **not** an end-to-end remote-publication smoke path. Running the daemon end to end requires tickets that declare GitHub SSH repositories, SSH push authorization, and a fine-grained token.

The recovery sample projects and recovery ticket remain as samples, but they are not proof scenarios. This runner does not provide the removed factory engine's bounded-recovery policy, protected acceptance-test machinery, publication contract, PR artifact, or engine report guarantees.

## Retained surfaces

- `factory/`: the local-ticket runner implementation (see "Runner implementation")
- `.env.example`: the `GITHUB_TOKEN` template at the repository root
- `samples/`: independent .NET fixture projects and Markdown tickets
- `standards/skills/`: read-only agent skills and companion material
- `proof/scenarios/`: five minimal scenario mappings
- `proof/harness/materialize-fixture.ts`: disposable repository preparation
- `proof/harness/evaluate.ts`: standalone evaluator dispatch
- `proof/evaluators/`: five independent evaluators and `StructureEvaluator`
- `proof/harness/fulfillment_routing_stub.py`: allocation evaluator dependency
- `proof/expected/`: five evaluator positive controls

The old custom factory engine (packages, applications, stage/recovery harness, engine tests, and configuration), the earlier `.sandcastle/` monolith, the merge agent, and the global target-repository (`--repo`) workflow are not part of this runner.
