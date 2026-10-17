---
id: inventory-stock-adjustment
name: adjust-stock-with-audit-trail
repository: git@github.com:Dazing/forge-test-repo.git
baseBranch: main
dependsOnTickets: []
---

# Correct a location's counted stock with a recorded reason

## What to build

Add `POST /inventory/{sku}/locations/{location}/adjustments`, the only path that can move
recorded stock to a counted reality (shrinkage, cycle-count fixes) while leaving a reason
behind. Receipts can only add, and they bypass the safety-stock floor; transfers enforce the
floor. Nothing today corrects a bad count, so the floor is unenforceable below the receipts
path and stock movements have no explanation.

Request body:

```json
{ "delta": -3, "reason": "cycle count" }
```

Success is `200 OK` with normalized identifiers, the applied delta, the resulting available
quantity, and the floor that bounded it:

```json
{
  "sku": "WIDGET",
  "location": "NORTH",
  "delta": -3,
  "available": 7,
  "safetyStock": 2
}
```

Every adjustment appends one audit record in the same critical section as the stock write.
Reading that history back over HTTP is a separate ticket and must not be built here.

## Context and constraints

Repository: `forge-test-repo`, a .NET 10 ASP.NET Core minimal API organized as vertical
slices. Test-first per `AGENTS.md`; no new packages, no controllers, no services, no
repositories, no MediatR, no shims. Warnings are errors.

- New slice `src/Inventory.Api/Features/Inventory/AdjustStock.cs`, one capability per file:
  endpoint mapping, an internal `Execute`, its request/result records, and an
  `AdjustStockOutcome` enum with `Adjusted`, `Invalid`, `UnknownSku`, `UnknownLocation`,
  `BelowSafetyStock`, and a distinct outcome for integer range violation (`OutOfRange`).
  Both map to `409`, and keeping them distinct preserves why a write was refused. The
  endpoint `switch` throws for an unhandled outcome, as the sibling slices do.
- `Data` (`src/Inventory.Api/Data/InventoryState.cs`) gains exactly two persistence-shaped
  members: `Dictionary<Guid, StockAdjustmentRecord> Adjustments` and
  `internal sealed record StockAdjustmentRecord(Guid Id, string Sku, string Location, int Delta,
  int ResultingAvailable, string Reason, DateTimeOffset OccurredUtc)`. `Data` keeps no
  routing, quantity, or HTTP policy, and the record is never serialized into a response.
- Mirror `TransferStock.Execute`: trim then `ToUpperInvariant` for SKU and location,
  case-insensitive storage lookup, uppercase public representation, validation of
  identifiers and delta before the lock, entity resolution inside one `lock (state.SyncRoot)`
  acquisition that snapshots, computes, and commits.
- The floor is the hard invariant, identical in spirit to the transfer source-floor rule
  (`TransferStock.Execute` uses `Math.Max(0, source.Available - source.SafetyStock)`):
  the adjustment is refused when the resulting available quantity is strictly below that
  location's `SafetyStock`. A delta that lands exactly on the floor is allowed.
- An adjustment never creates a SKU or a location. `POST .../receipts` owns creation, and
  new locations created there start at safety stock `0`.
- Exactly one `state.Version++` per successful adjustment, with the audit append inside the
  same lock. Every refusal is mutation-free: no stock change, no audit record, no version
  bump. Successful no-ops do not exist here, because `delta == 0` is rejected.

## Acceptance criteria

- [ ] Seeded `WIDGET`/`NORTH` (available 10, safety stock 2) accepts `delta: -8` and returns
      `200` with normalized `sku`/`location`, the `delta`, `available: 2`, `safetyStock: 2`.
- [ ] The next `delta: -1` on the same location returns `409`, and `NORTH` stays at
      available 2: the floor is a hard invariant, exactly-at-floor allowed, one below refused.
- [ ] `delta: 0`, a blank/whitespace `reason`, and blank identifiers return `400` using the
      repository's validation-problem shape keyed by the offending field.
- [ ] An unknown SKU and a known SKU with an unknown location both return `404`, and the
      unknown location is not created (a later lookup for that SKU lists no new location).
- [ ] `delta` that would overflow `int`, and `delta` that would drive available below zero,
      both return `409` with state untouched.
- [ ] A positive `delta` succeeds and raises available; the response `available` always
      equals the seeded available plus the delta.
- [ ] Each successful adjustment appends exactly one `StockAdjustmentRecord` to
      `state.Adjustments` carrying a new GUID, uppercase SKU/location, the delta, the
      resulting available quantity, the reason, and a UTC occurrence timestamp; the global
      `state.Version` rises by exactly one for that write.
- [ ] Precedence is `400` (shape) before `404` (identity) before `409` (floor/range): an
      unknown SKU with `delta: 0` is `400`, a known SKU with an unknown location and a
      floor-breaking delta is `404`.
- [ ] Every `400`, `404`, and `409` leaves stock, `Adjustments`, and `Version` unchanged,
      and the adjustment is visible through `GET /inventory/{sku}` available totals.
- [ ] `README.md` gains the route in the API table and a paragraph in the inventory section
      covering delta semantics, the floor, the no-creation rule, and the audit record.

## Verification

From the repository root:

```bash
dotnet build Inventory.slnx
dotnet run --project tests/Inventory.Tests/Inventory.Tests.csproj
```

Add the new checks to `tests/Inventory.Tests/Program.cs` following its conventions
(top-level call, one static function per scenario, `Assert(condition, message)`, the
existing `SeedLocation`/`PhysicalStock` helpers, `internal` slices reachable through
`InternalsVisibleTo`) and update the final `PASS: 14 ...` count line. Cover the
`400`/`404`/`409` precedence, the exact-at-floor and one-below boundary, positive and
negative deltas, one-version-bump-per-write, one-audit-record-per-write, and
failure-is-mutation-free.

The harness calls `Execute` directly, so the HTTP status mapping needs a live app:

```bash
ASPNETCORE_URLS=http://localhost:5000 dotnet run --project src/Inventory.Api/Inventory.Api.csproj
curl -is -X POST localhost:5000/inventory/widget/locations/north/adjustments -H 'content-type: application/json' -d '{"delta":-8,"reason":"cycle count"}'
curl -is -X POST localhost:5000/inventory/widget/locations/north/adjustments -H 'content-type: application/json' -d '{"delta":-1,"reason":"shrinkage"}'
curl -is -X POST localhost:5000/inventory/widget/locations/north/adjustments -H 'content-type: application/json' -d '{"delta":0,"reason":"cycle count"}'
curl -is -X POST localhost:5000/inventory/widget/locations/east/adjustments -H 'content-type: application/json' -d '{"delta":-1,"reason":"cycle count"}'
curl -is localhost:5000/inventory/WIDGET
```

Expect `200`, `409`, `400`, `404` in that order, and the final lookup showing `NORTH`
available 2 with aggregate allocatable reflecting the correction.
