---
id: inventory-adjustment-history
name: read-stock-adjustment-history
repository: git@github.com:Dazing/forge-test-repo.git
baseBranch: main
dependsOnTickets: ["inventory-stock-adjustment"]
---

# Read a SKU's stock adjustment history back over HTTP

## What to build

Add `GET /inventory/{sku}/adjustments`, the read half of the audit trail. An adjustment that
cannot be inspected leaves the "why did this stock move" gap open: the record exists only in
process memory, so a shrinkage correction is no more explainable to a caller than it was
before. This endpoint returns one SKU's adjustments, oldest first.

Success is `200 OK` with an array ordered chronologically:

```json
[
  {
    "id": "6f1c2a3e-0000-0000-0000-000000000000",
    "sku": "WIDGET",
    "location": "NORTH",
    "delta": -8,
    "resultingAvailable": 2,
    "reason": "cycle count",
    "occurredUtc": "2026-10-17T06:51:00+00:00"
  }
]
```

A known SKU with no adjustments returns `200` with `[]`. A blank or unknown SKU returns `404`.

## Context and constraints

Repository: `forge-test-repo`, .NET 10 ASP.NET Core minimal API, vertical slices under
`src/Inventory.Api/Features/`. Test-first per `AGENTS.md`; no new packages, controllers,
services, repositories, or shims. Warnings are errors.

- New slice `src/Inventory.Api/Features/Inventory/GetStockAdjustments.cs`, mapping the route
  and exposing an internal `Execute` that returns the boundary response array (or `null` for
  "unknown SKU", matching how `GetInventory.Execute` signals absence).
- The response is a new boundary record. `StockAdjustmentRecord` in `Data` is a persistence
  record and must not be serialized into a response; `Data` gains nothing for this ticket.
- Shape follows `GetInventory`: the read takes one lock acquisition, projects, and releases;
  results are ordered, and ordering is defined explicitly so the contract is stable —
  chronological by `OccurredUtc`, with insertion order in `Adjustments` breaking ties,
  because `DateTimeOffset.UtcNow` can repeat within a process.
- Results are SKU-scoped and case-insensitive: identifiers are trimmed and
  `ToUpperInvariant` before lookup, so `/inventory/widget/adjustments` and
  `/inventory/WIDGET/adjustments` return the same rows, and rows for other SKUs never appear.
- The read is pure: no stock change, no `Adjustments` change, no `state.Version` increment,
  and two consecutive calls return equal results.
- `GET /reservations/{id}` is the response/header precedent for a single-resource read; do
  not add ETag, caching, paging, or filtering behavior here — reservation concurrency is a
  separate ticket.

## Acceptance criteria

- [ ] Two adjustments applied in sequence to the same SKU return in chronological order,
      each with its id, uppercase SKU/location, delta, `resultingAvailable`, reason, and UTC
      timestamp, and the entries match what the adjustments endpoint returned.
- [ ] Adjustments for a second SKU are not mixed into the first SKU's result, and a trimmed
      lowercase SKU path returns the same rows as the uppercase form.
- [ ] A SKU that exists in stock with no adjustments returns `200 []`, not `404`.
- [ ] A blank SKU and an unknown SKU return `404`.
- [ ] The read is mutation-free: `state.Version`, all available quantities, and
      `state.Adjustments.Count` are identical before and after, and a repeat call returns an
      equal sequence.
- [ ] `README.md` gains the route in the API table and documents ordering, the empty-list
      case, and the `404` case in the inventory section.

## Verification

From the repository root:

```bash
dotnet build Inventory.slnx
dotnet run --project tests/Inventory.Tests/Inventory.Tests.csproj
```

Add checks to `tests/Inventory.Tests/Program.cs` following its conventions (top-level call,
one static function per scenario, `Assert(condition, message)`, existing
`SeedLocation`/`PhysicalStock` helpers, `InternalsVisibleTo` access to `internal` slices) and
update the final `PASS: 15 ...` count line. Seed state by driving the adjustment slice's
`Execute`, not by writing `Data` records directly, so ordering is exercised the way the
endpoint produces it.

Status codes and JSON shape need a live app, because the harness calls `Execute` directly:

```bash
ASPNETCORE_URLS=http://localhost:5000 dotnet run --project src/Inventory.Api/Inventory.Api.csproj
curl -is -X POST localhost:5000/inventory/widget/locations/north/adjustments -H 'content-type: application/json' -d '{"delta":-8,"reason":"cycle count"}'
curl -is -X POST localhost:5000/inventory/widget/locations/south/adjustments -H 'content-type: application/json' -d '{"delta":-1,"reason":"shrinkage"}'
curl -is localhost:5000/inventory/widget/adjustments
curl -is localhost:5000/inventory/gadget/adjustments
```

Expect two `200` adjustments, then `200` with both rows in chronological order (the
case-insensitive lowercase path returns them), then `404`.
