---
name: tdd
description: >-
  Test-Driven Development workflow with agentic guardrails — short uniform
  cycles (one test → minimal code → refactor), plus the build-prd blind
  surface-suite exception, evidence requirements, and testability-first design.
  Language-neutral kernel. Use when implementing a feature/endpoint/job, adding
  logic with clear I/O, or writing tests. Pairs with the
  `vertical-slice-architecture` skill when VSA is adopted; that skill supplies
  platform-specific test tooling and tier examples.
---

# TDD Workflow

Test-Driven Development with agentic guardrails. Optimizes for decomposition,
short cycles, and verifiability so a human can trust code an agent wrote by
reading its tests.

This is the language-neutral kernel. Concrete runners, tiers, and examples live
in the platform references of the `vertical-slice-architecture` skill:

- TypeScript → `platforms/typescript` (web/api dialects, vitest/RTL/supertest).
- C# / .NET → `platforms/dotnet` (Unit/Slice/Integration tiers,
  xUnit/FluentAssertions).

## When this applies

- Implementing a feature, endpoint, job, or business rule.
- Adding logic with clear inputs and outputs.
- Writing tests for existing or new code.

## Core principles

1. **Decomposition** — the normal inner discipline is one test per cycle.
2. **Blind surface-suite authoring** — `build-prd` may freeze one complete
   execution-frozen FE or BE suite before GREEN. The approved PRD surface is the
   bound, not an arbitrary case-count limit. One writer authors every planned
   test and fixture; one separate builder makes the suite GREEN.
3. **Short feedback** — the builder uses ordered GREEN checkpoints and the
   smallest affected command, not separate writer/builder cycles.
4. **Testability first** — identify I/O seams before implementation and inject
   dependencies.
5. **Task fit** — exploratory or ambiguous work is a spike, not TDD.

## Shared surface definitions

A **surface** is one independently executable application boundary:

- **FE:** browser UI and client-side state, VSA TypeScript + `web`.
- **BE:** API, persistence, or background processing, VSA .NET + `api|jobs`
  or VSA TypeScript + `api` as detected by the repository.

A PRD mentioning both FE and BE is dual-surface. Each surface has its own
execution-frozen test-plan, build-plan, writer, builder, manifest, verification,
and review.

A **test group** is an organizational heading inside one surface test-plan. It
never creates an agent, approval gate, manifest, or implementation boundary.

A **GREEN checkpoint** is an ordered milestone executed by the same builder after
the complete suite is frozen. It names the test IDs, final production files,
final behavior, narrow commands, and dependencies. It must not prescribe
knowingly provisional behavior that a later checkpoint replaces.

Every test case declares its runtime shape:

```text
<pure|host|host+db|browser> x <number of iterations>
```

Count expanded theory rows. For generated loops state the loop count or upper
bound. The surface execution profile is informational and records total test
IDs, RED artifacts, RED commands, full-stack invocations, pure generated
iterations, and materialized RED-packet bytes. It does not split a surface.

A full-stack invocation crosses an application host, browser render, container,
database, network fake, or equivalent integration boundary. A pure in-process
iteration is not full-stack.

### Hermetic integration

Agent-executed integration tests MUST be hermetic unless the approved execution
envelope explicitly provides native-local or external infrastructure:

- start the real application host inside the test process or test command;
- exercise the public HTTP, job, or browser boundary through real routing,
  middleware, serialization, validation, authorization, and handlers;
- use fixture-owned process-local stores, temporary files, loopback listeners,
  and deterministic network fakes;
- replace only unavailable external systems at explicit DI/composition-root
  seams, never internal handlers or decision logic;
- reject unexpected network calls and own all resource reset and cleanup;
- require no Docker, Testcontainers, Compose, fixed port, or network egress.

`host+db` MUST name the database implementation in test setup. A repository or
store fake without a database is `host`, not `host+db`. A substitute proves only
the behavior it faithfully implements. Provider-specific SQL, migrations,
collation, transaction isolation, locking, broker delivery, cloud identity, TLS,
and similar vendor semantics require the real provider through an approved
native-local or external compatibility command. If that environment is
unavailable, the case is `BLOCKED`; never claim substitute coverage as provider
compatibility.

### Property testing

- Pure deterministic invariants receive property coverage at a pure seam.
- Infrastructure wiring receives finite integration examples.
- Generated full-stack property tests are prohibited unless the row contains
  `EXPENSIVE INTEGRATION PROPERTY - HUMAN APPROVAL REQUIRED`, has explicit human
  approval, uses at most 10 iterations, and reuses one warmed host/fixture.

## Normal TDD cycle

The normal cycle is:

1. **Write one test** for one specific observable behavior.
2. **Run it RED** with the exact command and actual failure output.
3. **Write minimal real implementation** for that behavior.
4. **Run it GREEN** with the same command and actual pass summary.
5. **Refactor only while green**, then rerun the command.

Run the full tier at feature completion and all tiers at final verification.

## Blind surface-suite exception

The `build-prd` pipeline is an acceptance-first exception:

> The normal TDD cycle is one test → RED → minimal GREEN → refactor. The
> build-prd pipeline has one blind writer author and prove the complete
> execution-frozen surface suite RED before seeing any implementation plan. The
> suite is frozen. One separate builder then makes the suite GREEN through narrow
> ordered checkpoints without editing tests, followed by final refactoring. The
> approved PRD surface—not an arbitrary case-count budget—is the bound.

Surface-wide sequence:

1. The blind writer creates every planned test and shared fixture.
2. Run all planned RED verification commands.
3. Classify every case and freeze one SHA-256 manifest.
4. If Structural RED exists, the builder adds the complete declaration-only
   scaffold named by the build-plan.
5. Verify the manifest and rerun all RED commands until every test is Behavioral
   RED.
6. The same builder executes every GREEN checkpoint in order using narrow
   commands; verify the manifest after each checkpoint.
7. Confirm every execution-frozen surface test GREEN.
8. Refactor once after complete GREEN and rerun every narrow command.
9. Run full build, touched tiers, full suite, and separate smoke/end-to-end.
10. Review the complete surface diff independently; fix findings test-first.

The builder sees the complete build-plan after the manifest is frozen. Do not
withhold later checkpoints or spawn replacement agents at checkpoint boundaries.
An interrupted run resumes from the same durable handoff and manifest; a
continuation is not a new architectural subdivision.

## RED classifications

- **Structural RED:** tests cannot compile only because named planned public
  production symbols do not exist.
- **Behavioral RED:** compiled tests fail for the expected missing or incorrect
  observable behavior.
- **Already implemented:** a planned test passes before production behavior is
  added; stop at the planning/drift gate.
- **BLOCKED:** package, compiler, tool, infrastructure, timeout, or unrelated
  failure prevents valid RED evidence.

Structural RED may precede only the declaration-only scaffold frozen in the
build-plan. After that scaffold, rerun unchanged tests and prove Behavioral RED
for every case before implementing behavior. Generic placeholder throws are not
RED evidence.

## Evidence requirements

After each test run record:

1. Exact command.
2. Summary line with pass/fail counts and duration.
3. For failures, the assertion message in 1–5 lines.
4. Observed elapsed wall time and model (`unknown` when unavailable).
5. Generated file count and byte count after each agent phase.

Infrastructure, package, tool, and environment failures are BLOCKED, never RED.
Never claim completion without observed evidence.

## Test immutability

The surface-wide SHA-256 manifest includes every test source and test-only
fixture created or modified by the writer. Verify it after RED authoring, after
declaration scaffolding, at every GREEN checkpoint, before and after final
refactor, and before surface verification. Any change is `TEST MUTATION`: stop
and report before/after hashes without restoring or silently accepting it.
Plan drift requires a new execution-frozen contract, fresh RED evidence, and a
new manifest. `plan-prd` requires human re-approval; `split-plan-prd` regenerates
and finalizes affected artifacts without a test-plan approval gate.

## Checkpoint rule

Before implementation, commit or stage the failing tests when the repository
workflow supports it. This makes tampering diff-visible and revertable. Never
delete or rewrite a failing test to make production code pass.

## Testability-first design

Before writing production code:

1. Identify database, HTTP, filesystem, external API, host, and browser seams.
2. Design dependencies for injection.
3. Extract business logic into pure units with plain data inputs.
4. Keep external work behind explicit seams.
5. For each external boundary, record the production implementation, test
   implementation, behavior proven, and behavior intentionally not proven.

| Tier | What it tests | Setup |
|---|---|---|
| Unit | Extracted pure logic and decision rules | Plain objects, no infrastructure |
| Slice | One capability handler against real data access | Fixture-owned process-local store or explicit boundary fake |
| Integration | Full round-trip | Real host with fixture-owned test infrastructure |

## Anti-patterns

- Unbounded bulk test generation outside the execution-frozen surface-suite exception.
- Faking GREEN by deleting or weakening tests.
- Skipping RED evidence.
- Knowingly temporary production behavior, such as serial fan-out before planned
  bounded concurrency or permissive authorization before policy enforcement.
- Full-suite builds after every checkpoint instead of narrow feedback.
- Tight coupling that hides I/O seams.
- Assuming Docker/Testcontainers or inventing an infrastructure prerequisite not
  present in the approved execution envelope.
- Using a lightweight substitute to claim production-provider compatibility.

## Test naming

Name tests for observable behavior, not methods:
`<Unit>_<ExpectedBehavior>_<Condition>`, for example
`CanBeCancelled_ReturnsFalse_WhenAlreadyShipped`. Pipeline tests also cite the
criterion ID, for example `B2_pasted_url_is_rejected`.

## Relationship

- **`build-prd`** — uses the blind surface-suite exception, one writer, one
  builder, one immutable manifest, ordered checkpoints, final verification, and
  independent review for each surface.
- **`build-prd-solo`** — mirrors the same surface phases with instruction-based
  rather than architectural blindness.
- **`plan-prd` / `split-plan-prd`** — produce the complete execution-frozen
  surface suite and checkpoint build-plan that this workflow executes;
  `plan-prd` has a human test-plan gate and `split-plan-prd` does not.
- **`vertical-slice-architecture`** — provides concrete platform tiers, runners,
  and dialect seams when the repository adopts VSA.
