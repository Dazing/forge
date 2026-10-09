---
name: factory-acceptance-test-design
description: Authoritative acceptance-suite protocol for the controlled inventory POC.
---

# Acceptance suite protocol

Within the workspace, test design and the single authorized correction write only `.factory/acceptance-candidate/`. Never change production files, the trusted runner, or other repository paths during either operation. Put probe helpers, temporary scripts, logs, and exploratory output only in the external writable scratch location explicitly supplied by the execution backend (`/home/agent/factory-scratch`). Do not create `.factory/probe` or other temporary workspace directories, and never copy or link scratch into the candidate suite. Scratch is isolated per operation, is not publication input, and is removed after confirmed worker shutdown; include durable observations in the final report rather than citing disposable scratch paths.

Create `manifest.json`:

```json
{
  "schemaVersion": 2,
  "tests": [
    {
      "id": "stable_test_id",
      "file": "stable_test_id.json",
      "criteria": ["TICKET-CRITERION-ID"],
      "rationale": "Why this observable behavior proves the criterion and why baseline failure is expected."
    }
  ],
  "expectations": [
    {
      "criteria": ["TICKET-CRITERION-ID"],
      "target": "stable_test_id step 1 status",
      "provenance": {
        "kind": "ticket",
        "source": "criterion quotation or repository contract path",
        "rationale": "Why this source determines the expected value"
      },
      "distinguishingInput": "The input/state that distinguishes a plausible wrong implementation",
      "expectedResult": "The observable expected result",
      "rejects": "The plausible incorrect behavior this assertion rejects",
      "materialAlternative": false,
      "ambiguity": "resolved",
      "derived": false
    }
  ]
}
```

Every listed file is a declarative executable HTTP case interpreted by the host-owned runner:

```json
{
  "id": "stable_test_id",
  "criteria": ["TICKET-CRITERION-ID"],
  "steps": [
    {
      "method": "POST",
      "path": "/reservations",
      "json": { "sku": "WIDGET", "quantity": 2 },
      "expect": { "status": 201, "json": { "status": "Pending" } },
      "captureReservationId": "id"
    },
    {
      "method": "POST",
      "path": "/reservations/${reservationId}/confirm",
      "expect": { "status": 204 }
    }
  ]
}
```

`method` defaults to `GET`. `expect.status` is required. `expect.json` maps dotted JSON property paths to exact expected values. `captureReservationId` records one response property for later `${reservationId}` substitution. Each case runs against a fresh application process and fixed baseline data.

Derive each expected value from the original requirement and the ordered state transitions in that case, independently of the implementation under test. Account for every preceding reservation, confirmation, cancellation, and quantity change before asserting availability or a rejection. For example, with stock 10 and 4 units reserved, availability is `10 - 4 = 6`; stock 11 with the same reservation gives `11 - 4 = 7`, which is greater than 6. Do not expect an availability of 6 for both states or accept a disputed result merely because current code produces it.

Choose feasible distinguishing boundary inputs: identify the permitted boundary and the nearest reachable value on each relevant side, using the state that the scenario actually establishes. An impossible request that fails an earlier stock or validation rule does not distinguish a later availability boundary. Explain the state arithmetic and why the observable result separates the allowed case from the rejected case in the rationale. When requirements do not determine an expectation, report the ambiguity rather than inventing a rule.

Every consequential assertion group needs one expectation entry. Use provenance kind `ticket`, `repository-contract`, or `assumption`. A material alternative cannot proceed as an assumption, and `ambiguity: "unresolved"` with `materialAlternative: true` blocks freezing. Repository-consistent non-material assumptions may proceed only when explicitly recorded.

For calculated or state-transition expectations, set `derived: true` and add `derivation` with non-empty `setupState`, `transition`, and `predicate`. Pair a rejection boundary with a feasible case when that distinction matters. Metadata validation proves completeness and binding, not arithmetic truth.

Feature and bug cases MUST fail by an assertion for the intended missing behavior. Refactor cases MUST pass before implementation. Infrastructure failures, malformed cases, skipped cases, zero cases, and unrelated command failures are invalid evidence. Map every ticket criterion in both the manifest and final stage report. Do not copy, modify, or replace the host-owned runner or an authoritative suite mounted under `/home/agent/factory-inputs/acceptance`.

For feature and bug test-design reports, use criterion verdict `unmet` with the intentional RED evidence; `met` is reserved for criteria already satisfied. For refactors, use `met` with baseline GREEN evidence. The orchestrator checks criterion mapping and baseline RED/GREEN execution outcomes; these checks do not prove that authored arithmetic, state transitions, or boundary expectations are semantically correct. The author must justify those expectations from the contract. Do not continue if this skill is unavailable through OpenCode's native `skill` tool.
