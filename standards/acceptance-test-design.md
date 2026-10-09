---
name: factory-acceptance-test-design
summary: Authoritative acceptance-suite protocol for the controlled inventory POC.
---

# Acceptance suite protocol

The test-design stage writes only `.factory/acceptance-candidate/`. Never change production files during test design.

Create `manifest.json`:

```json
{
  "schemaVersion": 1,
  "tests": [
    {
      "id": "stable_test_id",
      "file": "stable_test_id.json",
      "criteria": ["TICKET-CRITERION-ID"],
      "rationale": "Why this observable behavior proves the criterion and why baseline failure is expected."
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

Feature and bug cases MUST fail by an assertion for the intended missing behavior. Refactor cases MUST pass before implementation. Infrastructure failures, malformed cases, skipped cases, zero cases, and unrelated command failures are invalid evidence. Map every ticket criterion in both the manifest and final stage report. Do not copy, modify, or replace the host-owned runner or an authoritative suite mounted under `/factory-inputs/acceptance`.

For feature and bug test-design reports, use criterion verdict `unmet` with the intentional RED evidence; `met` is reserved for criteria already satisfied. For refactors, use `met` with baseline GREEN evidence. The orchestrator validates mapping and RED/GREEN semantics independently.
