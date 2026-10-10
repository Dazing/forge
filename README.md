# Local Sandcastle runner

This repository adapts Matt Pocock's Sandcastle runner for local Markdown tickets. It runs Pi in Docker against a separately materialized disposable Git repository, while tickets, skills, evaluators, and expected solutions remain in this source checkout.

The runner uses `@ai-hero/sandcastle@0.12.0`, Pi `0.73.1`, and the OpenAI-compatible model ID `vllm-qwen38-27b` at `https://openai.taila49adb.ts.net/v1`. It keeps ten planning iterations, up to four concurrent implementation/review workers, one reused implementation/review sandbox per branch, and a final merge into the disposable target repository.

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

The container uses host networking so Pi can resolve the tailnet hostname and use the host's Tailscale routes. `factory/harness/models.json` defines the `local-vllm` provider and is mounted read-only into the agent's directory (`models.json` for Pi, `models.yml` for oh-my-pi); no Anthropic or OpenAI API credential is required for this local service.

`npm run sandcastle -- --help` prints runner help without requiring Docker.

## Prepare, run, and evaluate

Each scenario starts from its own sample fixture. Preparation creates a timestamped repository under the source checkout's `.run/` directory, copies only the selected fixture, and initializes that copy as a new Git repository. The generated path is printed for use by the runner and evaluator.

```bash
RUN_PATH=$(npm run --silent prepare:scenario -- proof/scenarios/vsa-allocation-feature.json)
npm run sandcastle -- --repo "$RUN_PATH" --ticket samples/tickets/vsa-allocation-feature.md --agent-harness oh-my-pi
npm run evaluate -- proof/scenarios/vsa-allocation-feature.json "$RUN_PATH"
```

Repeat `--ticket <markdown-path>` to supply multiple related local tickets for the same target baseline. Never combine tickets from different proof scenarios: each scenario has its own independently materialized repository. Ticket IDs are generated from the ticket paths and contents; they are not external issue numbers.

Tickets are read on the host and supplied in full to the agent. The target must already be a Git repository. During every agent stage, `standards/skills/` is mounted read-only at the harness's native global skill location (`/home/agent/.pi/agent/skills/` for Pi, `/home/agent/.omp/agent/skills/` for oh-my-pi). The agent discovers each `SKILL.md`, and the planner, implementer, reviewer, and merger prompts require relevant skills and companion files to be read. A failed implementation, review, or merge makes the runner command fail.

Agent output is written under `factory/.logs/<run timestamp>-<process ID>/` in this runner checkout. Each planner, implementer, reviewer, and merger stage gets a separate human-readable progress log containing assistant text and concise tool-start summaries while omitting raw Pi events such as thinking blocks and tool output. The main process prints stage progress and the path to each log.

## Proof scenarios

The five retained proof modes map fixtures to host-side tickets, skills, evaluators, and expected-solution positive controls:

| Mode | Scenario | Fixture | Ticket |
|---|---|---|---|
| Feature | `proof/scenarios/feature.json` | `samples/feature` | `samples/tickets/feature.md` |
| Bug | `proof/scenarios/bug.json` | `samples/bug` | `samples/tickets/bug.md` |
| Refactor | `proof/scenarios/refactor.json` | `samples/refactor` | `samples/tickets/refactor.md` |
| VSA feature | `proof/scenarios/vsa-feature.json` | `samples/vsa-feature` | `samples/tickets/vsa-feature.md` |
| VSA allocation | `proof/scenarios/vsa-allocation-feature.json` | `samples/vsa-allocation-feature` | `samples/tickets/vsa-allocation-feature.md` |

For any row, use the same three-command pattern shown above with that scenario, a fresh destination, and its ticket. `npm run evaluate -- <scenario.json> <candidate-repository>` invokes the scenario's independent evaluator and returns its pass/fail status. Expected solutions under `proof/expected/` are evaluator positive controls only; neither they nor `proof/evaluators/` are copied into an agent repository.

The recovery sample projects and recovery ticket remain as samples, but they are not proof scenarios. This runner does not provide the removed factory engine's bounded-recovery policy, protected acceptance-test machinery, publication contract, PR artifact, or engine report guarantees.

## Retained surfaces

- `factory/`: local-ticket runner, prompts, harness adapters, and the Docker sandbox image
- `samples/`: independent .NET fixture projects and Markdown tickets
- `standards/skills/`: read-only agent skills and companion material
- `proof/scenarios/`: five minimal scenario mappings
- `proof/harness/materialize-fixture.ts`: disposable repository preparation
- `proof/harness/evaluate.ts`: standalone evaluator dispatch
- `proof/evaluators/`: five independent evaluators and `StructureEvaluator`
- `proof/harness/fulfillment_routing_stub.py`: allocation evaluator dependency
- `proof/expected/`: five evaluator positive controls

The old custom factory packages, applications, stage/recovery harness, engine tests, and configuration are not part of this runner.
