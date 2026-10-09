# Local Software Factory POC

A local-first proof of concept for a hands-off coding pipeline: give it a Markdown ticket with acceptance criteria and receive a tested, reviewed Git branch—or an explicit failure report.

The goal is to prove the **core orchestration engine**: fresh agent contexts, reliable handoffs, quality gates, protected acceptance tests, and bounded recovery.

## Workflow

1. **Test design:** a fresh agent writes executable acceptance tests, criterion mappings, and expectation provenance before implementation.
2. **Implementation:** a fresh agent implements the ticket using TDD.
3. **Refactor:** a fresh agent makes supported behavior-preserving improvements or reports a justified no-op. Behavioral defects become findings, not refactor edits.
4. **Independent review:** a read-only fresh agent emits contract-compliance and implementation-quality verdicts plus evidence-backed findings.
5. **Conditional repair:** blocking findings consume one of two run-wide repair rounds. A repair agent claims each authorized finding; a separate read-only re-review verifies resolution and repair consequences.
6. **Pull-request draft:** after exact-tree verification, a fresh read-only explanation agent describes the complete change from an isolated copy; the orchestrator renders `PR.md`.
7. **Output:** the orchestrator publishes the unchanged verified solution branch without merging it.

Agents execute autonomously inside a container or sandbox. Shared and role-specific skills are explicit OpenCode skill directories containing `<name>/SKILL.md`; the backend mounts only the skills selected for that role under `/home/agent/.config/opencode/skills/<name>`. Repository-specific instructions still come from the target repository's `AGENTS.md`.

Stage gates combine automated checks with explicit acceptance-criteria verdicts. Downstream agents cannot modify authoritative acceptance tests. Review/re-review receive a host-created read-only candidate copy and external writable scratch. Suspected test defects use one controlled correction path.

Each operation has at most two execution attempts. Review `changes-required` is a completed judgment, not an execution retry. Two repair rounds are shared across refactor/review findings. Exhaustion stops with findings and host evidence preserved.

Prompts use a six-part role contract: purpose, permitted changes, forbidden changes, required evidence, completion, and escalation. Handoffs contain compact report pointers and versioned host evidence bound to tree and suite identities. Full sanitized check output is available through mounted read-only artifact paths instead of accumulated inline report bodies.

Agents emit role-discriminated `stage_report` JSON. Review completion is separate from approval; repair claims cannot independently close findings. Publication requires every criterion met, no unresolved blocking finding, an approved review/re-review for the current candidate identity, and final exact-tree verification.

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

The implemented backend is Sandcastle 0.12.0 with OpenCode and one configured vLLM OpenAI-compatible endpoint. Every Sandcastle agent invocation uses OpenCode's `medium` reasoning-effort variant. TypeScript is the orchestrator language. OpenHands is not shipped. See the runtime compatibility record for the observed infrastructure blocker.

## Documentation

- [Product brief](docs/software-factory-poc-brief.md): agreed outcome, workflow, constraints, and proof cases.
- [Implementation plan](docs/software-factory-poc-implementation-plan.md): module boundaries, repository layout, contracts, delivery phases, and verification criteria.
- [VSA API proof scenario plan](docs/vsa-api-proof-scenario-implementation-plan.md): additive six-slice inventory scenario, trusted acceptance design, evaluator coverage, delivery phases, and verification matrix.
- [VSA allocation API proof scenario plan](docs/vsa-allocation-api-proof-scenario-implementation-plan.md): location-aware six-slice baseline, external routing boundary, optimistic allocation commit, evaluator coverage, and verification matrix.
- [Orchestrator observability plan](docs/orchestrator-observability-implementation-plan.md): durable lifecycle events, early transcripts, deadline containment, supervision, and status inspection.
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
RUN_ID="feature-$(date +%s)"
npm run factory -- run --config config/factory.local.json --ticket samples/tickets/feature.md --branch factory/feature-001 --run-id "$RUN_ID"
# From another terminal:
npm run factory -- status --config config/factory.local.json --run-id "$RUN_ID"
```

The run command emits sequenced `FACTORY_PROGRESS` JSON records on stderr and one terminal JSON outcome on stdout. The status command reads host-owned evidence without changing the run. Success exit code is `0`, product failure is `1`, configuration/infrastructure failure is `2`, and cancellation is `130`. A branch collision fails; the factory never force-updates, merges, or modifies the base branch.

The POC intentionally supports only an unauthenticated vLLM endpoint on a trusted container network, so no inference credential enters the agent environment or transcript. Endpoint credentials/query strings are rejected. `config/sample-repository.json` is trusted host configuration and MUST remain outside the disposable agent clone.

`sharedSkills` lists language, domain, architecture, and engineering standards that apply to every role. `roleSkills` explicitly lists procedure skills for each operation (`test-design`, `implementation`, `refactor`, `review`, `acceptance-correction`, `repair`, `re-review`, and `pull-request`). Entries point to skill directories, not individual Markdown files. The directory name and the `name` field in `SKILL.md` must use the same valid OpenCode skill name. There is no legacy `standards` alias.

## Checks

```bash
npm run check
npm test -- --run tests/integration/preflight.test.ts
for fixture in feature bug refactor recovery-success recovery-exhaustion vsa-feature vsa-allocation-feature; do
  dotnet build samples/$fixture/src/Inventory.Api/Inventory.Api.csproj --nologo
  dotnet run --project samples/$fixture/tests/Inventory.Tests/Inventory.Tests.csproj
done
proof/evaluators/feature.sh proof/expected/feature
proof/evaluators/bug.sh proof/expected/bug
proof/evaluators/refactor.sh proof/expected/refactor
proof/evaluators/vsa-feature.sh proof/expected/vsa-feature
proof/evaluators/vsa-allocation-feature.sh proof/expected/vsa-allocation-feature
export PROOF_ID="$(date +%s)"
for scenario in feature bug refactor recovery-success recovery-exhaustion vsa-feature vsa-allocation-feature; do
  npx tsx proof/harness/run-proof.ts config/factory.local.json \
    "proof/scenarios/$scenario.json" "factory/proof-$scenario-$PROOF_ID" "$PROOF_ID-$scenario"
done
```

The five expected-solution evaluators above MUST pass; running them against their corresponding `samples/*` baselines MUST fail. The original five-case proof matrix remains intact, `vsa-feature` adds a sixth independent architecture-feature run, and `vsa-allocation-feature` adds a seventh independent location-allocation run. `npm test` is deterministic orchestration/adapter evidence, not a substitute for real-model proof runs.

The execution-backend test deterministically verifies the native OpenCode discovery mount and required prompt. A real proof additionally requires each attempt transcript to show native `skill` tool calls for every configured skill; path presence or prompt text alone is not runtime proof.

## Evidence and failure handling

Host-owned run evidence is written under `<runRoot>/evidence/<run-id>/`: sequenced `events.jsonl`, pre-created attempt transcripts, `supervisor.json`, attachments, `artifacts/PR.md`, `report.json`, and `report.md`. Every live progress event is persisted before publication. `PR.md` is produced only after exact-tree verification and is not committed into the solution branch. Verification state and immutable authoritative suites are under `<trustedRoot>/<run-id>/`; neither path is mounted writable into the agent container. Failed disposable workspaces remain under `<runRoot>/workspaces/` for diagnosis. Successful output branches are local branches in the configured source repository.

Each coding stage and the pull-request drafting step have two attempts. The one optional acceptance correction is a fresh test-design session and does not reset the reporting stage's budget. Timeouts, malformed reports, failed gates, and runtime failures consume an attempt. Cancellation is terminal. Recovery starts only after backend stop confirmation. If a runner ignores cancellation beyond `attemptShutdownGraceSeconds`, the run becomes terminal `shutdown-stalled`; no recovery or later stage starts, and the outer supervisor terminates the worker. Pull-request attempts inspect fresh disposable analysis clones; their changes are discarded and cannot alter the verified publication workspace.

## Current verification status

Factory policy, adapters, real local Git isolation/publication, trusted process checks, and all seven fixture HTTP surfaces are implemented and deterministically exercised as detailed in the evidence record. Real Sandcastle/OpenCode/vLLM execution remains blocked in the current environment: no vLLM endpoint/model configuration is available, Docker and Podman are absent, and unprivileged user namespaces are disabled. Therefore no real-model proof report or successful factory output branch is claimed.

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