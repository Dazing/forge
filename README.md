# Local Sandcastle runner

This repository adapts Matt Pocock's Sandcastle runner for local Markdown tickets. It runs Pi or oh-my-pi in Docker against a separately materialized disposable Git repository, while tickets, skills, evaluators, and expected solutions remain in this source checkout. The runner is implemented in `factory/`; the earlier `.sandcastle/` monolith is not part of this runner.

The runner uses `@ai-hero/sandcastle@0.12.0`, Pi `1.1.0`, oh-my-pi `18.8.4`, and the OpenAI-compatible model ID `vllm-qwen38-27b` at `https://openai.taila49adb.ts.net/v1`. It runs continuously as a daemon, polling the ticket directory every 10 seconds, selects at most `MAX_PARALLEL = 1` ticket per planning iteration, uses one implementation/review sandbox per ticket, and merges the implemented branches into the disposable target repository each iteration.

## Prerequisites

- Node.js 24 and npm 11
- Git
- Docker
- .NET SDK 10 and Python 3 for running the standalone evaluators on the host
- Host Tailscale connectivity to `https://openai.taila49adb.ts.net/v1`

Install dependencies and build the runner image:

```bash
npm install
npx sandcastle docker build-image \
  --image-name local-sandcastle-runner:latest \
  --dockerfile factory/sandbox/Dockerfile
```

The container uses host networking so the agent can resolve the tailnet hostname and use the host's Tailscale routes. `factory/harness/models.json` defines the `local-vllm` provider and is mounted read-only into the agent's directory (`models.json` for Pi, `models.yml` for oh-my-pi); no Anthropic or OpenAI API credential is required for this local service.

`npm run sandcastle -- --help` prints runner help without requiring Docker.

## Prepare, run, and evaluate

Each scenario starts from its own sample fixture. Preparation creates a timestamped repository under the source checkout's `.run/` directory, copies only the selected fixture, and initializes that copy as a new Git repository. The generated path is printed for use by the runner and evaluator.

```bash
RUN_PATH=$(npm run --silent prepare:scenario -- proof/scenarios/vsa-allocation-feature.json)
npm run sandcastle -- --repo "$RUN_PATH" --tickets-dir samples/tickets --agent-harness oh-my-pi
npm run evaluate -- proof/scenarios/vsa-allocation-feature.json "$RUN_PATH"
```

The runner polls `--tickets-dir` every 10 seconds for Markdown ticket files. Keep one scenario's tickets in one directory; never combine tickets from different proof scenarios: each scenario has its own independently materialized repository. Ticket IDs are SHA-256 content hashes (first 16 hex characters) of each ticket's Markdown, and each ticket's branch is `sandcastle/ticket-<id>`; they are not external issue numbers.

Tickets are read on the host and supplied in full to the agent. The target must already be a Git repository. During every agent stage, `standards/skills/` is mounted read-only at the harness's native global skill location (`/home/agent/.pi/agent/skills/` for Pi, `/home/agent/.omp/agent/skills/` for oh-my-pi). The agent discovers each `SKILL.md`, and the planner, implementer, reviewer, and merger prompts require relevant skills and companion files to be read. A failed implementation, review, or merge makes the runner command fail.

The Docker image installs RoslynMcp 1.2.3 and configures the `roslyn` and `microsoft-learn` MCP servers for both harnesses. Every stage prompt is prefixed with a required MCP tool workflow, and for Pi a `check-mcp.mjs` preflight runs before each stage to verify Pi 1.1.0 and that the required MCP servers and tools are directly exposed.

Agent output is written under `.logs/<run timestamp>-<process ID>/` at the root of this runner checkout. Each planner, implementer, reviewer, and merger stage gets a separate human-readable progress log containing assistant text and concise tool-start summaries while omitting raw Pi events such as thinking blocks and tool output. The main process prints stage progress and the path to each log.

## Runner implementation

The runner is the `factory/` tree, split by responsibility:

- `factory/main.ts` — composition root and daemon main loop: parse flags, validate the target repository and ticket directory, run the sandbox preflight, require a clean initial worktree, then loop forever discovering `*.md` tickets, sleeping 10 seconds when none are pending, calling `solveTickets`, and logging each iteration's outcome.
- `factory/cli/cli.ts` — flag parsing for `--repo`, `--tickets-dir`, `--agent-harness` (`pi` default, `pi`/`oh-my-pi`), and `--help`.
- `factory/orchestration/ticket-orchestrator.ts` — one planning iteration: run the planner, reject any planner commits or uncommitted changes, validate the plan, run implement and review concurrently per ticket, aggregate failures, run the merge agent, verify each branch is merged into `HEAD`, and require a clean post-merge worktree.
- `factory/tickets/tickets.ts` — ticket loading (content-hash IDs, `sandcastle/ticket-<id>` branches, duplicate-content rejection), ticket-directory scanning, `formatTickets`, the `planSchema` (`MAX_PARALLEL = 1`), and `validatePlan`.
- `factory/shared/` — `git.ts` (target-repo git client), `paths.ts` (path/directory checks), and `sleep.ts` (poll timer).
- `factory/sandbox/` — `sandbox.ts` (Docker provider, read-only skill/model mounts, preflight, clean-sandbox check), `Dockerfile` (Pi 1.1.0, oh-my-pi 18.8.4, RoslynMcp 1.2.3, .NET 10 runtime), and `check-mcp.mjs` (Pi MCP preflight).
- `factory/harness/` — `harness-agents.ts` (agent construction, the four stage runs, the MCP tool workflow prepended to every prompt, tool-summary logging, and the completion signal), `oh-my-pi.ts` (oh-my-pi adapter), and `models.json` (the `local-vllm` provider).
- `factory/prompts/` — the plan, implement, review, and merge prompts.

Each stage runs in the Docker sandbox against the target repository. The planner is read-only and returns a `<plan>` JSON selection; the implementer and reviewer share one reusable sandbox on the ticket's branch and must end with a clean worktree and a `<promise>COMPLETE</promise>` signal; the merger merges each reviewed branch into `HEAD` with `git merge --no-edit` and verifies the merge. Any stage that fails its completion signal, leaves uncommitted changes, or fails a check makes the runner command fail.

## Proof scenarios

The five retained proof modes map fixtures to host-side tickets, skills, evaluators, and expected-solution positive controls:

| Mode | Scenario | Fixture | Ticket |
|---|---|---|---|
| Feature | `proof/scenarios/feature.json` | `samples/feature` | `samples/tickets/feature.md` |
| Bug | `proof/scenarios/bug.json` | `samples/bug` | `samples/tickets/bug.md` |
| Refactor | `proof/scenarios/refactor.json` | `samples/refactor` | `samples/tickets/refactor.md` |
| VSA feature | `proof/scenarios/vsa-feature.json` | `samples/vsa-feature` | `samples/tickets/vsa-feature.md` |
| VSA allocation | `proof/scenarios/vsa-allocation-feature.json` | `samples/vsa-allocation-feature` | `samples/tickets/vsa-allocation-feature.md` |

For any row, use the same three-command pattern shown above with that scenario, a fresh destination, and its ticket directory. `npm run evaluate -- <scenario.json> <candidate-repository>` invokes the scenario's independent evaluator and returns its pass/fail status. Expected solutions under `proof/expected/` are evaluator positive controls only; neither they nor `proof/evaluators/` are copied into an agent repository.

The recovery sample projects and recovery ticket remain as samples, but they are not proof scenarios. This runner does not provide the removed factory engine's bounded-recovery policy, protected acceptance-test machinery, publication contract, PR artifact, or engine report guarantees.

## Retained surfaces

- `factory/`: the local-ticket runner implementation (see "Runner implementation")
- `samples/`: independent .NET fixture projects and Markdown tickets
- `standards/skills/`: read-only agent skills and companion material
- `proof/scenarios/`: five minimal scenario mappings
- `proof/harness/materialize-fixture.ts`: disposable repository preparation
- `proof/harness/evaluate.ts`: standalone evaluator dispatch
- `proof/evaluators/`: five independent evaluators and `StructureEvaluator`
- `proof/harness/fulfillment_routing_stub.py`: allocation evaluator dependency
- `proof/expected/`: five evaluator positive controls

The old custom factory engine (packages, applications, stage/recovery harness, engine tests, and configuration) and the earlier `.sandcastle/` monolith are not part of this runner.
