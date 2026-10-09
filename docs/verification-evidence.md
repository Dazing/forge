# POC acceptance and verification evidence

Evidence recorded 2026-10-09. `PASS` means the cited command was observed in this environment. `BLOCKED` is not completion.

## Delivery-phase exits

| Phase | Status | Concrete evidence |
|---|---|---|
| 0 — runtime compatibility | **BLOCKED** | `docs/runtime-compatibility.md`. Sandcastle/OpenCode API and versions inspected; no vLLM configuration and no Docker/Podman. No real tool-calling claim. |
| 1 — boundaries and fixtures | **PASS** | `npm run check`; ticket parser tests; the original five .NET 10 fixtures plus additive `vsa-feature` and `vsa-allocation-feature`; all seven fixture builds/tests pass. The allocation baseline exposes six working business slices and intentionally omits reallocation. |
| 2 — workspace, evidence, verification | **PASS for local mechanisms; container enforcement BLOCKED** | Git adapter real-repository tests, artifact tests, verifier tests, and `tests/integration/preflight.test.ts`. Docker read-only mount denial and verifier/application container separation remain blocked. |
| 3 — real happy path | **BLOCKED** | Four-stage sequential implementation and deterministic tests exist. No actual vLLM run, real report, or output branch exists. |
| 4 — recovery/correction | **PASS deterministically; real agent recovery BLOCKED** | Focused 26-test command covers successful recovery, two-attempt exhaustion, invalid report, correction, timeout/stop, suite tampering, publication hardening, and branch preservation. Fault decorator is `proof/harness/fault-injecting-backend.ts`. |
| 5 — proof suite | **BLOCKED for real model; deterministic VSA paths PASS** | Existing independent evaluators still pass. The allocation baseline fails at the missing PUT only after all six baseline-slice checks; its oracle passes calculation, mapping, upstream failure, timeout, stale-snapshot, and concurrent-conservation checks. No result is represented as model-produced. |

## Brief definition of done

| Requirement | Status | Evidence or blocker |
|---|---|---|
| One manual invocation runs one ticket without intervention | **BLOCKED** | CLI is runnable and its missing-endpoint failure was observed with exit 2. Actual run needs vLLM and Docker. |
| Every stage/recovery uses fresh context | **PASS deterministically** | Factory attempt IDs/session IDs are unique; backend rejects reused orchestration or OpenCode runtime session IDs and never calls Sandcastle resume/fork. |
| Autonomous sandbox agents use configured vLLM | **BLOCKED** | Endpoint/model/container prerequisites absent. |
| Acceptance tests are independently enforced | **PASS locally; sandbox denial BLOCKED** | Host-owned immutable suites, digest checks, direct trusted runner, zero/skipped/infrastructure rejection, integration-copy verification, and read-only baseline copies that preserve executable launch permissions. Same-UID host execution is not a sandbox boundary. |
| Feature, bug, refactor produce committed satisfying branches | **BLOCKED** | Fixed baselines and expected-solution evaluators are proven; no substitute branches are published or claimed. |
| Injected first failure recovers once | **PASS deterministically; real model BLOCKED** | Factory workflow test and proof-only attempt-boundary decorator. |
| Injected recovery failure stops accurately | **PASS deterministically; real model BLOCKED** | Exactly two implementation attempts and no later stage in workflow tests and `proof/evaluators/recovery-exhaustion.sh`. |
| No run modifies/merges base branch | **PASS for real Git adapter** | Disposable-repository tests prove source refs untouched before publication, collision refusal, exact designated branch publication, no merge commit, unchanged base ref, ignored hostile Git filters, and rejection of nested Git metadata. |

## Implementation-plan completion checklist

| Plan item | Status | Location/evidence |
|---|---|---|
| Actual vLLM/runtime compatibility | **BLOCKED** | `docs/runtime-compatibility.md` |
| Directed modules and replaceable contracts | **PASS** | `packages/factory/src/contracts.ts`, package public exports, `tools/check-dependencies.ts` |
| Markdown ticket without human intervention | **BLOCKED at runtime** | Parser/CLI implemented; real backend prerequisites absent |
| Fresh sessions and explicit handoffs | **PASS deterministically** | `execute-ticket.ts`, `stages.ts`, backend identity tests |
| Meaningful tests and rationale before implementation | **PASS in verifier contract; real agent BLOCKED** | Candidate manifest/rationale validation, expected RED/GREEN policy, `standards/acceptance-test-design.md` |
| TDD/refactor/review evidence | **PASS in contracts and observed feature run** | Run `1791550785-feature` completed all four model stages and trusted gates; its final publication exposed the ignored-output identity defect now covered by the Git workspace regression. |
| Tests/gates outside downstream write authority | **PASS locally; mount proof BLOCKED** | verifier host paths/digests/modes and Docker readonly mount configuration |
| Bounded recovery/correction | **PASS** | Two attempts/stage, one correction, cancellation terminal, malformed/timeout consume budget, workspace snapshots have orchestration deadlines, and proof workers have an external no-progress supervisor. |
| Final checks match publishable content | **PASS deterministically** | Verifier hashes the exact tree before/after final checks; publication derives verification, copying, and materialized-commit comparison from one Git publishable-file set, excludes ignored build/runtime outputs, rejects nested Git metadata, and updates the new source ref only after identity equality. |
| New branch only/base unchanged | **PASS** | real Git adapter tests |
| Seven proof cases exercised | **BLOCKED for complete real-model suite; deterministic VSA cases PASS** | The original five-case matrix remains historically unchanged. Both additive VSA fixtures, trusted RED preflights, oracles, and evaluators are exercised; their real-model runs are blocked by the same Docker/vLLM prerequisites. |
| Operations/replacement boundaries documented | **PASS** | `README.md`, `docs/runtime-compatibility.md` |

## Observed commands and outcomes

```text
npm run typecheck
  PASS, no diagnostics

npm run check:dependencies
  PASS, no forbidden/deep imports

npm run check
  PASS: typecheck and dependency checks; 13 test files, 50 tests, including three real .NET preflight cases and protected routing-stub/list-path checks

npm test -- --run packages/factory/src/execute-ticket/execute-ticket.test.ts packages/execution-backend/src/execution-backend.test.ts packages/verification/src/trusted-verification.test.ts packages/git-workspace/src/git-workspace.test.ts
  PASS: 4 files, 26 tests

npm test -- --run tests/integration/preflight.test.ts
  PASS: 1 file, 3 tests; feature, VSA quantity, and VSA allocation fixtures materialize, pass baseline checks, and classify their missing HTTP contracts as assertion RED

npm test -- packages/factory/src/execute-ticket/execute-ticket.test.ts proof/harness/process-supervisor.test.ts tests/integration/configuration.test.ts
  PASS: 3 files, 11 tests; durable snapshot boundaries, timeout failure report, external worker termination/diagnostic, and timeout configuration

npm test -- packages/git-workspace/src/git-workspace.test.ts
  PASS: 1 file, 6 tests; real disposable Git publication excludes ignored build outputs while preserving exact committed bytes and source refs

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

No `.runs/<run-id>/report.json` from a real model and no factory output branch exist. This is the required honest result while Phase 0 is blocked. Deterministic tests write only temporary repositories and do not masquerade as model proof branches.
