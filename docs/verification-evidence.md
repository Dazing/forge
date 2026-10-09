# POC acceptance and verification evidence

Evidence recorded 2026-10-09. `PASS` means the cited command was observed in this environment. `BLOCKED` is not completion.

## Delivery-phase exits

| Phase | Status | Concrete evidence |
|---|---|---|
| 0 — runtime compatibility | **BLOCKED** | `docs/runtime-compatibility.md`. Sandcastle/OpenCode API and versions inspected; no vLLM configuration and no Docker/Podman. No real tool-calling claim. |
| 1 — boundaries and fixtures | **PASS** | `npm run typecheck`; `npm run check:dependencies`; ticket parser tests; five .NET 10 fixtures; real sample `/health` returned `{"status":"ok"}` and `/inventory` returned WIDGET quantity 10. |
| 2 — workspace, evidence, verification | **PASS for local mechanisms; container enforcement BLOCKED** | Git adapter real-repository tests, artifact tests, verifier tests, and `tests/integration/preflight.test.ts`. Docker read-only mount denial and verifier/application container separation remain blocked. |
| 3 — real happy path | **BLOCKED** | Four-stage sequential implementation and deterministic tests exist. No actual vLLM run, real report, or output branch exists. |
| 4 — recovery/correction | **PASS deterministically; real agent recovery BLOCKED** | Focused 26-test command covers successful recovery, two-attempt exhaustion, invalid report, correction, timeout/stop, suite tampering, publication hardening, and branch preservation. Fault decorator is `proof/harness/fault-injecting-backend.ts`. |
| 5 — proof suite | **BLOCKED for real model** | All independent fixtures and evaluators exist. Expected solutions pass and baselines fail their independent evaluators. No results are represented as model-produced. |

## Brief definition of done

| Requirement | Status | Evidence or blocker |
|---|---|---|
| One manual invocation runs one ticket without intervention | **BLOCKED** | CLI is runnable and its missing-endpoint failure was observed with exit 2. Actual run needs vLLM and Docker. |
| Every stage/recovery uses fresh context | **PASS deterministically** | Factory attempt IDs/session IDs are unique; backend rejects reused orchestration or OpenCode runtime session IDs and never calls Sandcastle resume/fork. |
| Autonomous sandbox agents use configured vLLM | **BLOCKED** | Endpoint/model/container prerequisites absent. |
| Acceptance tests are independently enforced | **PASS locally; sandbox denial BLOCKED** | Host-owned immutable suites, digest checks, direct trusted runner, zero/skipped/infrastructure rejection, integration-copy verification. Same-UID host execution is not a sandbox boundary. |
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
| TDD/refactor/review evidence | **PASS in required contracts/gates; real evidence BLOCKED** | Stage reports and trusted checks enforced; no actual model transcripts |
| Tests/gates outside downstream write authority | **PASS locally; mount proof BLOCKED** | verifier host paths/digests/modes and Docker readonly mount configuration |
| Bounded recovery/correction | **PASS** | two attempts/stage, one correction, cancellation terminal, malformed/timeout consume budget |
| Final checks match publishable content | **PASS deterministically** | Verifier hashes the exact tree before/after final checks; publication copies it through a sanitized trusted clone, rejects nested Git metadata, and compares the materialized commit-tree identity before updating the new source ref. |
| New branch only/base unchanged | **PASS** | real Git adapter tests |
| Five proof cases exercised | **BLOCKED for model results** | fixture/evaluator discrimination complete; no real runs |
| Operations/replacement boundaries documented | **PASS** | `README.md`, `docs/runtime-compatibility.md` |

## Observed commands and outcomes

```text
npm run typecheck
  PASS, no diagnostics

npm run check:dependencies
  PASS, no forbidden/deep imports

npm test
  PASS: 9 files, 39 tests, including the real .NET preflight integration

npm test -- --run packages/factory/src/execute-ticket/execute-ticket.test.ts packages/execution-backend/src/execution-backend.test.ts packages/verification/src/trusted-verification.test.ts packages/git-workspace/src/git-workspace.test.ts
  PASS: 4 files, 26 tests

npm test -- --run tests/integration/preflight.test.ts
  PASS: real disposable Git clone + .NET build + executable baseline behavior checks

proof/evaluators/{feature,bug,refactor}.sh proof/expected/<case>
  PASS: independent HTTP outcomes; refactor additionally passes reflection-based structural criterion

proof/evaluators/{feature,bug,refactor}.sh samples/<case>
  expected nonzero: feature 404, bug repeated cancellation 204, refactor lacks one shared Transition operation

npx tsx proof/harness/materialize-fixture.ts proof/scenarios/recovery-exhaustion.json /tmp/factory-recovery-exhaustion
  PASS: nullable expected solution and strict bounded-failure fault scenario validated/materialized

npm run factory -- run --config config/factory.example.json --ticket samples/tickets/feature.md --branch factory/cli-smoke
  exit 2: VLLM_BASE_URL missing (expected environment blocker)
```

A trusted-runner smoke initially failed because the temporary assertion expected string enum/`quantity`; the expected sample contract emits numeric status/`available`. The corrected declarative case passed. Both observations were retained here rather than silently rerun.

## Proof reports and branches

No `.runs/<run-id>/report.json` from a real model and no factory output branch exist. This is the required honest result while Phase 0 is blocked. Deterministic tests write only temporary repositories and do not masquerade as model proof branches.
