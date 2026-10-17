---
id: inventory-audited-stock-adjustments
name: audited-stock-adjustments
repository: git@github.com:Dazing/forge-test-repo.git
baseBranch: main
dependsOnTickets: []
---

# Adjust existing location stock with an atomic audit trail

## What to build

Allow operators to correct inventory counts without crossing the safety-stock floor, and expose a chronological audit trail explaining each successful correction. Deliver both routes in the same Inventory slice:

- `POST /inventory/{sku}/locations/{location}/adjustments` accepts `{ "delta": -3, "reason": "cycle count" }`. Return `200` with `sku`, `location`, `delta`, `available` (the resulting available quantity), and `safetyStock`.
- `GET /inventory/{sku}/adjustments` returns a JSON array of that SKU's adjustments ordered by `occurredUtc` ascending. Return `[]` for an existing SKU with no adjustments and `404` for an unknown SKU. Each entry exposes the audit fields described below through a slice-owned response DTO, not the persistence record itself.

SKU/location identity remains trimmed and case-insensitive; public identifiers are uppercase. Adjustments never create SKUs or locations. Receipts retain their existing creation behavior.

## Context and constraints

The repository is a .NET 10 minimal API organized into vertical slices. Read and follow `AGENTS.md`. Existing `TransferStock` enforces the source safety-stock floor; use that invariant, not receipt behavior, for adjustments. Existing in-memory `InventoryState` owns the single synchronization lock and persistence-shaped records. Global `Version` increments exactly once per successful mutation.

Add `Features/Inventory/AdjustStock.cs` for the endpoint mappings, operation, boundary DTOs, and `AdjustStockOutcome` with `Adjusted`, `Invalid`, `UnknownSku`, `UnknownLocation`, and `BelowSafetyStock`. Keep operation methods internal. The audit GET belongs to this same slice, not another capability file. Register mappings in composition-only `Program.cs`.

Data additions are persistence-shaped only:

- `Dictionary<Guid, StockAdjustmentRecord> Adjustments`, initially empty.
- `StockAdjustmentRecord(Guid Id, string Sku, string Location, int Delta, int ResultingAvailable, string Reason, DateTimeOffset OccurredUtc)`.

A successful operation records a unique ID, normalized SKU/location, submitted signed delta, resulting available quantity, nonblank reason, and UTC occurrence time. Preserve the reason text supplied by the caller; whitespace-only reasons are invalid. The audit covers manual adjustments only; do not retrofit receipts, transfers, or reservation activity with audit entries.

Acquire `InventoryState.SyncRoot` once for an adjustment's state-dependent work: inspect the current stock, compute and validate the candidate quantity, then commit the stock replacement, audit append, and one global version increment together. Do not publish partial changes or release/reacquire between snapshot and commit. Use arithmetic that cannot wrap before validation. A candidate outside the `int` range or below safety stock returns `409`, never an exception or wrapped quantity. Preserve the specified outcome vocabulary; HTTP conflicts do not require a new shared error framework.

For the audit GET, snapshot under the same lock and return slice-owned representations. Reads never mutate state. Use deterministic secondary ordering for equal timestamps without changing chronological order.

No cross-slice references, controllers, services, repositories, new packages, external persistence, compatibility shims, or unrelated changes. Do not implement reservation ETags or inventory ETags. This ticket is independent of reservation concurrency work.

## Acceptance criteria

- [ ] Valid positive and negative deltas update an existing location and return `200` with normalized identifiers, the submitted delta, resulting `available`, and unchanged `safetyStock`.
- [ ] Blank SKU/location, zero delta, or blank/null reason returns `400`. Invalid input takes precedence over an unknown SKU/location or an otherwise conflicting quantity.
- [ ] After input validation, unknown SKU returns `404`; for a known SKU, unknown location returns `404`. Missing entities take precedence over quantity conflicts, and no rejected request creates either entity.
- [ ] A result exactly equal to safety stock succeeds; a result one below it returns `409`. The invariant applies to the resulting quantity, including an existing below-floor location: only an adjustment reaching or exceeding its floor can succeed.
- [ ] Integer underflow and overflow return `409` without wrapping, throwing, or committing any part of the operation. Include extreme signed deltas in coverage.
- [ ] Each success appends exactly one complete matching audit entry and increments global `Version` exactly once. Stock and audit become visible atomically under the one lock.
- [ ] Every failure leaves all stock, safety stocks, reservations, audit entries, and global version unchanged. Concurrent adjustments cannot overwrite one another or jointly cross the floor.
- [ ] The audit GET returns only the requested SKU's entries in chronological order, normalized identifiers and all audit fields, `[]` for a known SKU without entries, and `404` for an unknown/blank SKU; repeated reads are mutation-free.
- [ ] README includes both API table rows, request/response examples, audit ordering, error precedence, floor and arithmetic rules, and in-memory audit lifetime. Existing receipt, transfer, and reservation behavior remains intact.

## Verification

Use test-first changes in `tests/Inventory.Tests/Program.cs`: introduce behavioral checks that fail before implementing the new capability. Cover mixed-invalidity `400/404/409` precedence; normalized identities; positive and negative deltas; exactly-at-floor and one-below-floor boundaries; existing below-floor stock; integer extremes; complete audit contents; chronological filtering; one version bump per success; and full before/after state equality on failures. Add a competing-adjustments scenario whose combined negative deltas would cross the floor, asserting that only affordable operations commit and every committed change has its matching audit entry.

Run the existing executable harness and API build from the target repository root:

```sh
dotnet run --project tests/Inventory.Tests/Inventory.Tests.csproj
dotnet build src/Inventory.Api/Inventory.Api.csproj
```

Also exercise the real HTTP surface. Start the API with an explicit local URL. On fresh seeded state, POST delta `-8` with a cycle-count reason to WIDGET/NORTH; expect `200`, available `2`, and safety stock `2`. POST another delta `-1`; expect `409` with inventory unchanged. GET WIDGET's adjustments; expect exactly the successful correction with its reason, resulting available, ID, and UTC timestamp. Exercise invalid input against missing entities to prove `400` precedence, valid input against an unknown location to prove `404`, and a known SKU with no adjustments to prove `[]`. Verify response DTOs rather than exposing Data records.

Keep deterministic regression coverage in the existing harness, update any affected existing checks, and remove throwaway smoke scaffolding. No commits, pushes, merges, or runner lifecycle changes are part of this ticket.
