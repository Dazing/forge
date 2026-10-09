# Local Software Factory POC

A local-first proof of concept for a hands-off coding pipeline: give it a Markdown ticket with acceptance criteria and receive a tested, reviewed Git branch—or an explicit failure report.

The goal is to prove the **core orchestration engine**: fresh agent contexts, reliable handoffs, quality gates, protected acceptance tests, and bounded recovery.

## Planned workflow

1. **Test design:** a fresh agent writes executable acceptance tests and a short rationale before implementation.
2. **Implementation:** a fresh agent solves the ticket using TDD.
3. **Refactor:** a fresh agent enforces repository standards and improves code quality.
4. **Code review:** a fresh agent identifies and fixes remaining issues.
5. **Pull-request draft:** after exact-tree verification, a fresh read-only explanation agent describes the complete change from an isolated copy; the orchestrator renders `PR.md`.
6. **Output:** the orchestrator publishes the unchanged verified solution branch without merging it.

Agents execute autonomously inside a container or sandbox. Each configured standard is an OpenCode skill directory containing `<name>/SKILL.md`; the backend mounts it read-only at `/home/agent/.config/opencode/skills/<name>` and requires every fresh agent to load it through OpenCode's native `skill` tool. Repository-specific instructions still come from the target repository's `AGENTS.md`.

Stage gates combine automated checks with explicit acceptance-criteria verdicts. Downstream agents cannot modify authoritative acceptance tests; suspected test defects use a controlled correction path.

A failed stage gets one fresh recovery attempt. If recovery fails, the run stops with diagnostic evidence rather than claiming success.

Each coding prompt supplies shared operating rules and only the assigned stage's procedure: contract-derived test design, small implementation RED/GREEN cycles, concrete standards refactoring, or bounded whole-branch review. After those gates, a separate prompt asks for a concise summary plus ELI5 and execution-order explanation; it cannot write to the publication workspace. Handoffs identify the original base commit and current tree snapshot, with instructions to inspect the full tracked diff and untracked files. Supplied skills are read-only OpenCode global skills; acceptance suites under `/home/agent/factory-inputs/` are separate read-only inputs explicitly permitted by the sample instructions.

Agents report every criterion using the tagged `stage_report` JSON contract. Completed test design may retain intentionally unmet criteria; downstream completion requires every criterion met without unresolved issues. Compilation alone never replaces required behavioral gates. These instructions guide the model; trusted orchestrator checks, test protection, and recovery budgets remain authoritative.

## POC scope

| Area | Scope |
|---|---|
| Input | One Markdown ticket with acceptance criteria |
| Invocation | Manual terminal invocation |
| Target repository | A controlled C#/.NET 10 sample project |
| Execution | One ticket at a time in an isolated workspace |
| Inference | Local vLLM deployment through an OpenAI-compatible endpoint |
| Output | A solution branch, host-owned `PR.md`, and evidence report—or an explicit failure report |
| Recovery | Agent-stage recovery within the running process |
| Standards | Repository instructions and supplied agent skills |

The proof suite will cover a medium feature, a bug fix, a behavior-preserving refactor, and deliberately injected failures demonstrating both successful recovery and bounded stopping.

### Out of scope

- GitLab integration, ticket queues, and parallel ticket processing.
- Automatic merge, deployment, or release.
- Resuming after the orchestrator crashes or restarts.
- General-purpose support for arbitrary repositories.
- Building a custom coding-agent runtime.

## Architecture direction

Use one modular application with separate responsibilities:

- **Factory core:** workflow state, stage gates, handoffs, and recovery policy.
- **Execution backend:** agent runtime integration and sandbox lifecycle.
- **Git workspace:** isolated repositories, snapshots, and branch publication.
- **Verification:** protected acceptance tests and trusted check execution.
- **Run artifacts:** evidence storage and reporting.
- **CLI:** configuration and dependency wiring.

Narrow contracts and enforced dependency boundaries keep these modules replaceable without spreading provider-specific behavior through the workflow. No microservices or generic plugin framework are planned for the POC.

The implemented backend is Sandcastle 0.12.0 with OpenCode and one configured vLLM OpenAI-compatible endpoint. TypeScript is the orchestrator language. OpenHands is not shipped. See the runtime compatibility record for the observed infrastructure blocker.

## Documentation

- [Product brief](docs/software-factory-poc-brief.md): agreed outcome, workflow, constraints, and proof cases.
- [Implementation plan](docs/software-factory-poc-implementation-plan.md): module boundaries, repository layout, contracts, delivery phases, and verification criteria.
- [VSA API proof scenario plan](docs/vsa-api-proof-scenario-implementation-plan.md): additive six-slice inventory scenario, trusted acceptance design, evaluator coverage, delivery phases, and verification matrix.
- [Runtime compatibility](docs/runtime-compatibility.md): selected versions, inspected capability, attempted checks, and missing real-runtime prerequisites.
- [Verification evidence](docs/verification-evidence.md): acceptance mapping, observed commands, proof status, and blockers.
- [Setup runbook](docs/runbook-setup.md): dependencies and configuration.
- [Suite runbook](docs/runbook-suite.md): deterministic checks, proof runs, and inspection.

## Install and run

Required: Node.js 24, npm 11, Git, .NET SDK 10, Docker, a built `software-factory-agent:0.1.0` image, and a vLLM model that demonstrably supports OpenCode tool calls.

```bash
npm install --ignore-scripts
docker build -t software-factory-agent:0.1.0 -f containers/agent/Dockerfile .
npx tsx proof/harness/materialize-fixture.ts proof/scenarios/feature.json /tmp/factory-feature
cp config/factory.example.json config/factory.local.json
# Edit config/factory.local.json: sourceRepository (for example /tmp/factory-feature),
# exact vllm.modelId, and a vllm.endpoint reachable from the agent container.
# For a host-only or Tailscale endpoint on Linux, set sandboxNetwork to "host".
npm run factory -- run --config config/factory.local.json --ticket samples/tickets/feature.md --branch factory/feature-001
```

The command emits one JSON terminal outcome. Success exit code is `0`, product failure is `1`, configuration/infrastructure failure is `2`, and cancellation is `130`. A branch collision fails; the factory never force-updates, merges, or modifies the base branch.

The POC intentionally supports only an unauthenticated vLLM endpoint on a trusted container network, so no inference credential enters the agent environment or transcript. Endpoint credentials/query strings are rejected. `config/sample-repository.json` is trusted host configuration and MUST remain outside the disposable agent clone.

`standards` entries point to skill directories, not individual Markdown files. The directory name and the `name` field in `SKILL.md` must use the same valid OpenCode skill name. To supply a personal global skill, explicitly add its absolute directory (for example `/home/alice/.config/opencode/skills/coding-best-practices`) to the private config; the factory never exposes all host skills implicitly.

## Checks

```bash
npm run check
npm test -- --run tests/integration/preflight.test.ts
for fixture in feature bug refactor recovery-success recovery-exhaustion; do
  dotnet build samples/$fixture/src/Inventory.Api/Inventory.Api.csproj --nologo
  dotnet run --project samples/$fixture/tests/Inventory.Tests/Inventory.Tests.csproj
done
proof/evaluators/feature.sh proof/expected/feature
proof/evaluators/bug.sh proof/expected/bug
proof/evaluators/refactor.sh proof/expected/refactor
export PROOF_ID="$(date +%s)"
for scenario in feature bug refactor recovery-success recovery-exhaustion; do
  npx tsx proof/harness/run-proof.ts config/factory.local.json \
    "proof/scenarios/$scenario.json" "factory/proof-$scenario-$PROOF_ID" "$PROOF_ID-$scenario"
done
```

The three expected-solution evaluators above pass; running them against their corresponding `samples/*` baseline MUST fail. `npm test` is deterministic orchestration/adapter evidence. It is not a substitute for the five real-model proof runs.

The execution-backend test deterministically verifies the native OpenCode discovery mount and required prompt. A real proof additionally requires each attempt transcript to show native `skill` tool calls for every configured skill; path presence or prompt text alone is not runtime proof.

## Evidence and failure handling

Host-owned run evidence is written under `<runRoot>/evidence/<run-id>/`: `events.jsonl`, transcripts and attachments, `artifacts/PR.md`, `report.json`, and `report.md`. `PR.md` is produced only after exact-tree verification and is not committed into the solution branch. Verification state and immutable authoritative suites are under `<trustedRoot>/<run-id>/`; neither path is mounted writable into the agent container. Failed disposable workspaces remain under `<runRoot>/workspaces/` for diagnosis. Successful output branches are local branches in the configured source repository.

Each coding stage and the pull-request drafting step have two attempts. The one optional acceptance correction is a fresh test-design session and does not reset the reporting stage's budget. Timeouts, malformed reports, failed gates, and runtime failures consume an attempt. Cancellation is terminal. Recovery starts only after backend stop confirmation. Pull-request attempts inspect fresh disposable analysis clones; their changes are discarded and cannot alter the verified publication workspace.

## Current verification status

Factory policy, adapters, real local Git isolation/publication, trusted process checks, the .NET fixtures, and the sample HTTP surface are implemented and exercised. Real Sandcastle/OpenCode/vLLM execution is blocked in the current environment: no vLLM endpoint/model configuration is available, Docker and Podman are absent, and unprivileged user namespaces are disabled. Therefore no real-model proof report or successful factory output branch is claimed.

The known same-host limitation is material: without Docker, filesystem modes and separate host-owned paths do not form a security boundary against arbitrary code running as the same OS user. The real proof MUST use the container paths documented in [runtime compatibility](docs/runtime-compatibility.md).

## Module replacement boundaries

| Change | Owned edit surface |
|---|---|
| Coding runtime | `packages/execution-backend`, `containers/agent`, CLI construction |
| Git publication | `packages/git-workspace` |
| Checks/sample stack | `packages/verification`, trusted profile and proof fixtures |
| Evidence presentation | `packages/run-artifacts` |
| Recovery policy | `packages/factory` only |

Adapters import only `@factory/core`; adapters never import one another. `npm run check:dependencies` enforces this and rejects deep package imports.