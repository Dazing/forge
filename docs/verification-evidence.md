# POC acceptance and verification evidence

Evidence recorded 2026-10-09. `PASS` means the cited command was observed in this environment. `BLOCKED` is not completion.

## OpenAI subscription cutover

Observed on 2026-10-09:

| Verification | Observed result |
|---|---|
| `npm run check` | PASS: TypeScript, dependency boundaries, 18 test files, 105 tests |
| Configuration smoke | PASS: resolved `openai/gpt-6-luna`, dedicated `.factory-auth/opencode/auth.json`, and Docker bridge networking |
| Sandcastle runner smoke with a temporary structurally valid fake OAuth record | Reached Sandcastle's Docker provider and stopped because `software-factory-agent:0.1.0` is not built locally |

The runner smoke proves configuration, dedicated-auth validation, Sandcastle entry, and Docker handoff only. It did not authenticate with OpenAI, invoke GPT-6 Luna, or prove tool behavior.

## Correction-boundary prerequisite

Implemented and verified locally on 2026-10-09 in response to run `1791562408-vsa-feature`. Historical run evidence was not rewritten.

| Verification | Observed result |
|---|---|
| `npm run check` | PASS: TypeScript and dependency checks; 17 test files, 90 tests; total command wall time 33.36 seconds |
| Disposable `npx tsx .correction-smoke.ts` | PASS: real Git workspace and trusted verifier accepted/froze a `9 → 11` correction against the original baseline, then passed implementation checks against the real .NET HTTP API; external backend scratch was writable and cleaned |
| Unauthorized helper in that smoke | PASS: `.factory/probe/helper.py` rejected with `correction-boundary-violation` and path diagnostics; no publication performed |
| `docker version` | BLOCKED: command not found, exit 127; actual Docker mount denial/release behavior and model execution were not exercised |

The smoke used an injected local runner only for the agent operation; it did not substitute for the host acceptance runner or HTTP application. It covered the delta-conflict criterion, not the full six-criterion ticket. The disposable script and temporary repositories were removed afterward. Its observed wall time was 18.51 seconds.

Permanent regression coverage includes external scratch isolation/cleanup, retention after stalled or uncertain shutdown, canonical temporary-path escape rejection, protected helper additions and source modifications/deletions, corrected-suite freezing, terminal correction causes without extra attempts or publication, and evidence/report/status preservation. Scratch lifecycle tests do not prove Docker OS enforcement.

Current implementation supplies `/home/agent/factory-scratch` as a separate per-operation writable mount; protected inputs remain read-only. The Docker adapter checks mount use before authorizing cleanup because Sandcastle 0.12 can suppress container stop/removal errors. Inspection uncertainty retains scratch rather than deleting a possibly live mount.

## Stage boundaries, host evidence, and independent review

Slices A–E of `docs/stage-boundaries-and-evidence-implementation-plan.md` are implemented deterministically:

- Host evidence bundles retain tree/suite identity, complete check outcomes, bounded failed-output excerpts, correction-boundary diagnostics, finding state, and durable report pointers. The backend materializes sanitized JSON bundles and referenced outputs outside the candidate, mounts both read-only under `/home/agent/factory-inputs/evidence-bundles` and `/home/agent/factory-inputs/evidence`, and rewrites host paths.
- Prompts use six-part role contracts and shared plus role-specific skills. Review/re-review receive independent-review procedure rather than implementation TDD procedure.
- Review and re-review use whole-checkout read-only analysis copies, writable external scratch, before/after identity verification, and host-produced base/candidate change packages. Findings have stable host IDs; repair claims do not close them.
- One run has at most two shared repair rounds, each with at most two repair attempts, trusted checks, and scoped re-review. Current-tree approval and zero open blockers are required before integration/publication.
- Candidate manifest version 2 binds expectation provenance, ambiguity, and derivation metadata into the frozen suite identity. Structural metadata validation explicitly does not certify arithmetic truth.
- Operator status/final reports expose operation, reviewed tree, repair round, blockers, finding lifecycle, and typed correction causes. Historical run data remains unchanged.

Observed local runtime smoke: a real temporary Git repository produced a host change package (`new.txt` added, `candidate.txt` modified); writes to the complete analysis checkout were denied; the analysis identity remained valid; the writable publication candidate retained its intended content; and the source `main` ref remained unchanged. Generated-prompt inspection loaded `config/factory.example.json`, confirmed the six role-contract sections and evidence authority label, supplied TDD only to implementation, and supplied independent-review procedure only to review.

The actual sandbox qualification remains blocked: `docker version` returned `command not found`. No Docker mount-enforcement or GPT-6 Luna behavior claim is made. The old/new repeated comparative agent trials, seeded-finding adjudication, and rollout decision remain blocked until Docker and a dedicated OpenCode OpenAI subscription login are available.

## Delivery-phase exits

| Phase | Status | Concrete evidence |
|---|---|---|
| 0 — runtime compatibility | **BLOCKED** | `docs/runtime-compatibility.md`. Sandcastle/OpenCode API and versions inspected; no dedicated OpenAI subscription auth file and no Docker/Podman. No real GPT-6 Luna tool-calling claim. |
| 1 — boundaries and fixtures | **PASS** | `npm run check`; ticket parser tests; the original five .NET 10 fixtures plus additive `vsa-feature` and `vsa-allocation-feature`; all seven fixture builds/tests pass. The allocation baseline exposes six working business slices and intentionally omits reallocation. |
| 2 — workspace, evidence, verification | **PASS for local mechanisms; container enforcement BLOCKED** | Git adapter real-repository tests, artifact tests, verifier tests, and `tests/integration/preflight.test.ts`. Docker read-only mount denial and verifier/application container separation remain blocked. |
| 3 — real happy path | **BLOCKED for the current pipeline** | Four coding stages plus isolated pull-request drafting are implemented and pass deterministic tests. No authenticated GPT-6 Luna run has exercised the new pull-request step, so no model-produced `PR.md` or current-pipeline success is claimed. |
| 4 — recovery/correction | **PASS deterministically; real agent recovery BLOCKED** | Focused tests cover coding-stage and pull-request recovery/exhaustion, invalid reports, correction, timeout/stop, suite tampering, analysis-copy isolation, publication hardening, and branch preservation. Fault decorator is `proof/harness/fault-injecting-backend.ts`. |
| 5 — proof suite | **BLOCKED for real model; deterministic VSA paths PASS** | All independent fixtures and evaluators exist. Expected solutions pass and baselines fail their independent evaluators. The allocation baseline fails at the missing PUT only after all six baseline-slice checks; its oracle passes calculation, mapping, upstream failure, timeout, stale-snapshot, and concurrent-conservation checks. No results are represented as model-produced. |

## Brief definition of done

| Requirement | Status | Evidence or blocker |
|---|---|---|
| One manual invocation runs one ticket without intervention | **BLOCKED** | CLI is runnable. An actual run needs Docker and a dedicated OpenCode OpenAI subscription login. |
| Every stage/recovery uses fresh context | **PASS deterministically** | Coding-stage and pull-request attempt IDs/session IDs are unique; backend rejects reused orchestration or OpenCode runtime session IDs and never calls Sandcastle resume/fork. |
| Autonomous sandbox agents use configured GPT-6 Luna | **BLOCKED** | Subscription authentication and container prerequisites are absent. |
| Supplied OpenCode skills are available to each agent | **PASS for deterministic delivery contract; real tool discovery BLOCKED** | Backend tests prove each configured skill directory is mounted read-only at OpenCode's global discovery path and each fresh prompt requires the native `skill` tool. Docker and subscription auth are absent, so no transcript-level skill call is claimed. |
| Acceptance tests are independently enforced | **PASS locally; sandbox denial BLOCKED** | Host-owned immutable suites, digest checks, direct trusted runner, zero/skipped/infrastructure rejection, integration-copy verification, and read-only baseline copies that preserve executable launch permissions. Same-UID host execution is not a sandbox boundary. |
| Feature, bug, refactor produce committed satisfying branches | **BLOCKED** | Fixed baselines and expected-solution evaluators are proven; no substitute branches are published or claimed. |
| Injected first failure recovers once | **PASS deterministically; real model BLOCKED** | Factory workflow test and proof-only attempt-boundary decorator. |
| Injected recovery failure stops accurately | **PASS deterministically; real model BLOCKED** | Exactly two implementation attempts and no later stage in workflow tests and `proof/evaluators/recovery-exhaustion.sh`. |
| No run modifies/merges base branch | **PASS for real Git adapter** | Disposable-repository tests prove source refs untouched before publication, collision refusal, exact designated branch publication, no merge commit, unchanged base ref, ignored hostile Git filters, and rejection of nested Git metadata. |

## Implementation-plan completion checklist

| Plan item | Status | Location/evidence |
|---|---|---|
| Actual GPT-6 Luna/runtime compatibility | **BLOCKED** | `docs/runtime-compatibility.md` |
| Directed modules and replaceable contracts | **PASS** | `packages/factory/src/contracts.ts`, package public exports, `tools/check-dependencies.ts` |
| Markdown ticket without human intervention | **BLOCKED at runtime** | Parser/CLI implemented; real backend prerequisites absent |
| Fresh sessions and explicit handoffs | **PASS deterministically** | `execute-ticket.ts`, `stages.ts`, backend identity tests |
| Meaningful tests and rationale before implementation | **PASS in verifier contract; real agent BLOCKED** | Candidate manifest/rationale validation, expected RED/GREEN policy, `standards/skills/factory-acceptance-test-design/SKILL.md` |
| TDD/refactor/review evidence | **PASS in contracts and observed feature run** | Run `1791550785-feature` completed all four model stages and trusted gates; its final publication exposed the ignored-output identity defect now covered by the Git workspace regression. |
| Tests/gates outside downstream write authority | **PASS locally; mount proof BLOCKED** | verifier host paths/digests/modes and Docker readonly mount configuration |
| Bounded recovery/correction | **PASS** | Two attempts per coding stage and pull-request draft, one correction, cancellation terminal, malformed/timeout consume budget, workspace snapshots have orchestration deadlines, and proof workers have an external no-progress supervisor. |
| Final checks match publishable content | **PASS deterministically** | Verifier hashes the exact tree before/after final checks; pull-request agents receive disposable analysis clones whose mutations cannot reach publication; publication derives verification, copying, and materialized-commit comparison from one Git publishable-file set. |
| New branch only/base unchanged | **PASS** | real Git adapter tests |
| Seven proof cases exercised | **BLOCKED for complete real-model suite; deterministic VSA cases PASS** | The original five-case matrix remains historically unchanged. A historical real-model feature run reached all four stages and created an output branch that passes its independent evaluator, but its report failed during post-publication cleanup. Both additive VSA fixtures, trusted RED preflights, oracles, and evaluators are exercised; the current OpenAI-subscription runs are blocked by Docker and authentication prerequisites. |
| Operations/replacement boundaries documented | **PASS** | `README.md`, `docs/runtime-compatibility.md` |

## Observed commands and outcomes

```text
npm run check (stage-boundaries implementation)
  PASS: typecheck, dependency boundaries, 18 test files, and 104 tests. Coverage includes evidence materialization/path containment, retry handoff, report discrimination, expectation ambiguity, read-only analysis identity, change packages, stale-review rejection, refactor/review repair routing, repair regressions, shared-budget exhaustion, status/artifact rendering, correction boundaries, and three real .NET preflight fixtures.

npm run check
  PASS: typecheck and dependency checks; 14 test files, 59 tests, including pull-request schema separation, bounded drafting recovery, analysis-copy isolation, deterministic PR.md rendering, native OpenCode skill discovery, exact-tree verification, all three real .NET preflight cases, and protected routing-stub/list-path checks

npm test -- --run packages/factory/src/execute-ticket/execute-ticket.test.ts packages/factory/src/pull-request.test.ts packages/execution-backend/src/execution-backend.test.ts packages/git-workspace/src/git-workspace.test.ts packages/run-artifacts/src/file-run-artifacts.test.ts packages/verification/src/trusted-verification.test.ts proof/harness/fault-injecting-backend.test.ts
  PASS: 7 files, 45 tests

npm test -- --run packages/execution-backend/src/execution-backend.test.ts
  PASS: pull-request and coding-stage contracts remain distinct; read-only explanation prompts, protected mounts, fresh runtime sessions, timeout, cancellation, and malformed-output handling are green

npm test -- --run tests/integration/preflight.test.ts
  PASS: 1 file, 3 tests; feature, VSA quantity, and VSA allocation fixtures materialize, pass baseline checks, and classify their missing HTTP contracts as assertion RED

npm test -- packages/factory/src/execute-ticket/execute-ticket.test.ts proof/harness/process-supervisor.test.ts tests/integration/configuration.test.ts
  PASS: 3 files, 11 tests; durable snapshot boundaries, timeout failure report, external worker termination/diagnostic, and timeout configuration

npm test -- packages/git-workspace/src/git-workspace.test.ts
  PASS: 1 file, 8 tests; a mutated pull-request analysis clone cannot change the verified publication workspace or published branch

Run 1791552358-feature
  Observed: all four stages and final gates passed; output branch factory/proof-feature-1791552358 was created at 5110a85f, then cleanup failed unlinking the read-only integrated suite. The run remains failed evidence; the cleanup regression reproduces and fixes that post-publication failure without rerunning it.

proof/evaluators/feature.sh <checkout-of-factory/proof-feature-1791552358>
  PASS: feature independent HTTP acceptance; evaluator accepts the preserved baseline `quantity` representation and any explicit 4xx rejection where the ticket does not prescribe an exact status

npx tsx proof/harness/run-proof.ts config/factory.local.json proof/scenarios/feature.json factory/proof-supervisor-smoke supervisor-smoke-1791544643
  Expected environment failure: supervised worker completed with exit 1 because the sandbox image is unavailable; report.json, snapshot events, FACTORY_PROGRESS output, and supervisor.json were all observed

npx tsx proof/harness/run-proof.ts config/factory.local.json proof/scenarios/feature.json factory/proof-feature-permission-fix permission-fix-feature
  BLOCKED before agent execution: local Docker CLI/image software-factory-agent:0.1.0 unavailable

proof/evaluators/{feature,bug,refactor}.sh proof/expected/<case>
  PASS: existing independent HTTP outcomes; refactor additionally passes reflection-based structural criterion

proof/evaluators/vsa-feature.sh samples/vsa-feature
  expected nonzero after readiness, receipt, create, confirm, cancel, and inventory checks: PATCH returned 404

proof/evaluators/vsa-feature.sh proof/expected/vsa-feature
  PASS: adjustment delta, same-value, rollback, invalid, terminal, unknown, preservation, and concurrent conservation checks

proof/evaluators/vsa-allocation-feature.sh samples/vsa-allocation-feature
  expected nonzero after inventory, receipt, create, lookup, confirm, and cancel checks: PUT returned 404

proof/evaluators/vsa-allocation-feature.sh proof/expected/vsa-allocation-feature
  PASS: route mapping, allocation ordering, rollback, upstream 503/malformed/timeout translation, stale-snapshot rejection, and concurrent conservation checks

npm test -- --run proof/harness/trusted-acceptance.test.ts
  PASS: 1 file, 3 tests; dotted list indices, routing-stub lifecycle, and chunked .NET request-body handling

for fixture in feature bug refactor recovery-success recovery-exhaustion vsa-feature vsa-allocation-feature; do dotnet build ... && dotnet run ...; done
  PASS: all seven fixture APIs build with zero warnings and all seven local behavior executables pass

npx tsx proof/harness/materialize-fixture.ts proof/scenarios/vsa-allocation-feature.json /tmp/factory-vsa-allocation-feature
  PASS: clean main branch, no reallocation subfolder, materialized build and eight baseline behavior checks pass

npx tsx proof/harness/materialize-fixture.ts proof/scenarios/vsa-feature.json /tmp/factory-vsa-feature
  PASS: clean main branch, no adjustment slice, materialized build and local behavior checks pass

npx tsx proof/harness/materialize-fixture.ts proof/scenarios/recovery-exhaustion.json /tmp/factory-recovery-exhaustion
  PASS: nullable expected solution and strict bounded-failure fault scenario validated/materialized

npm run factory -- run --config config/factory.example.json --ticket samples/tickets/feature.md --branch factory/cli-smoke
  historical, before direct endpoint configuration: exit 2 because VLLM_BASE_URL was missing
```

A trusted-runner smoke initially failed because the temporary assertion expected string enum/`quantity`; the expected sample contract emits numeric status/`available`. The corrected declarative case passed. Both observations were retained here rather than silently rerun.

The first allocation-oracle evaluator run reached the routing stub but returned `502`: .NET `PostAsJsonAsync` used chunked transfer encoding while the initial host stub read only `Content-Length`. The stub was corrected to decode chunked request bodies, a regression test was added, and the evaluator then passed. The failing and passing observations are both retained.

## Proof reports and branches

Historical vLLM-backed feature attempts and one published feature branch are retained under `.runs/`; they predate the pull-request step and the OpenAI-subscription cutover, so they do not prove the current pipeline. No authenticated GPT-6 Luna run has produced the new host-owned `artifacts/PR.md`. Deterministic tests and the artifact smoke use only temporary paths and do not masquerade as model proof runs.
