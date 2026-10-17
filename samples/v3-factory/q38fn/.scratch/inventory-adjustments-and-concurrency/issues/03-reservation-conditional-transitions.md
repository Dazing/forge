---
id: reservation-conditional-transitions
name: enforce-reservation-transition-concurrency
repository: git@github.com:Dazing/forge-test-repo.git
baseBranch: main
dependsOnTickets: ["inventory-adjustment-history"]
---

# Make reservation confirmation and cancellation conditional on the read state

## What to build

`ConfirmReservation` and `CancelReservation` are last-write-wins: they check status only, so
two workers that both fetched a pending reservation both fire, the loser overwrites a
transition it never saw, and the second caller gets a bare `409` with no way to tell
"someone changed this after I read it" from "this was never pending". `InventoryState.Version`
already increments on every mutation and is exposed nowhere.

Expose a per-reservation version through HTTP conditional requests:

- `GET /reservations/{id}` returns the existing body plus
  `ETag: "<id>:<reservationVersion>"` — a strong, quoted validator, e.g.
  `ETag: "3f2b1c40-7a1e-4c1c-9a1d-6f0c1c2d3e4a:0"`.
- `POST /reservations/{id}/confirm` and `POST /reservations/{id}/cancel` require `If-Match`
  carrying that exact literal. Success is `204` as today; the transition is refused when the
  validator is stale.

A caller's flow: `GET` → read `ETag` → `POST` with `If-Match` → on `412`, re-read and decide
(retryable); on `409`, stop (terminal).

## Context and constraints

Repository: `forge-test-repo`, .NET 10 ASP.NET Core minimal API, vertical slices under
`src/Inventory.Api/Features/Reservations/`. Test-first per `AGENTS.md`; no new packages,
controllers, services, repositories, or shims. Warnings are errors.

- `Data` gains exactly one field: `int Version` on `ReservationRecord`. It is per-resource,
  not the global `InventoryState.Version`, so unrelated stock writes (receipts, transfers,
  adjustments) never invalidate a reservation's validator. A new reservation starts at
  version `0`, so `CreateReservation` initializes it; a successful confirm/cancel sets the
  status and increments that reservation's version exactly once, in the same lock
  acquisition as the existing single `state.Version++`.
- Response/header shaping (validator construction, `If-Match` parsing, outcome-to-status
  mapping) lives in the Reservations feature area as a small boundary type shared by the
  get, confirm, and cancel slices — for example a co-located
  `src/Inventory.Api/Features/Reservations/ReservationEtag.cs`. `AGENTS.md` forbids one slice
  referencing another and forbids HTTP concepts in `Data`; a header-shaping helper shared by
  the three reservation endpoints inside their own feature folder is the agreed reading of
  that rule, and nothing about validators may move into `Data`.
- The reservation version is not a JSON body field: `GET /reservations/{id}` keeps its exact
  current body (`id`, `sku`, `quantity`, `status`, `allocations`) and exposes the version only
  as the `ETag` header.
- Status ladder, in this precedence:
  1. `400` — `If-Match` is present but is not exactly one strong quoted validator equal to
     the `"<id>:<version>"` form: wildcard `*`, weak `W/"..."`, unquoted, list-valued, or
     carrying a foreign id. Use the repository's validation-problem shape.
  2. `428 Precondition Required` — `If-Match` is absent.
  3. `404` — unknown reservation id. Keep the `{id:guid}` route constraint: a non-GUID id is
     not matched by the endpoint, so id-shape problems surface as `404`, not `400`.
  4. `412 Precondition Failed` — the validator parses and is well-formed for this id, but the
     reservation's current version differs.
  5. `409` — the reservation is not pending, and for cancellation the existing
     stock-overflow conflict.
  `412` is ordered before `409` deliberately: a stale caller gets the retryable signal, not
  the terminal one. A confirm against an already-confirmed reservation with the pre-confirm
  validator is `412`, not `409`.
- Header validation needs no state, so `400`/`428` are decided before the lock. `404`, `412`,
  and `409` are all evaluated inside one `lock (state.SyncRoot)` acquisition, matching the
  existing single-acquire snapshot/compute/commit shape.
- `412` and `409` are mutation-free: no status change, no stock restore, no reservation
  version bump, no global version bump. A cancellation refused for stock overflow keeps the
  reservation pending with its version unchanged. `412` carries no `ETag` header; the client
  re-reads.
- Outcomes for the transition slices gain `PreconditionRequired`, `InvalidIfMatch`, and
  `PreconditionFailed` alongside `Succeeded`, `NotFound`, `NotPending` (and `StockOverflow`
  for cancel); each endpoint `switch` throws for an unhandled outcome, as siblings do.
- `GET /inventory/{sku}` ETags are the obvious follow-on and are deliberately out of scope.

## Acceptance criteria

- [ ] A newly created reservation is readable with `ETag: "<id>:0"`, and its JSON body is
      byte-for-byte the shape it had before this ticket.
- [ ] `POST .../confirm` with that validator returns `204`; a following `GET` shows
      `status: "Confirmed"` and an `ETag` ending `:1`.
- [ ] `POST .../cancel` on the confirmed reservation with the `:1` validator returns `409`
      (terminal), and with the stale pre-confirm `:0` validator returns `412` — the stale
      caller never sees `409`.
- [ ] The full ladder holds on a pending reservation: `*`, `W/"x"`, an unquoted literal, a
      list of validators, and a literal naming a different id all return `400`; a missing
      `If-Match` returns `428`; a validator whose id equals the route id of a reservation
      that does not exist returns `404`, as does a non-GUID route id; a well-formed
      `"<id>:7"` for an existing pending reservation returns `412`; the current validator on
      a non-pending reservation returns `409`.
- [ ] Every `400`, `428`, `404`, `412`, and `409` leaves reservation status, reservation
      version, per-location available quantities, and the global `InventoryState.Version`
      untouched; a successful transition raises the reservation version by exactly one and
      the global version by exactly one.
- [ ] Cancellation restored stock is unchanged by a rejected attempt, and a cancellation
      refused for stock overflow leaves the reservation pending with its version intact.
- [ ] An unrelated mutation (receipt, transfer, or stock adjustment) between a `GET` and a
      conditional `POST` does not invalidate the validator: the transition still succeeds.
- [ ] `README.md` API table rows for confirm and cancel document the required `If-Match`, and
      the reservations section documents the `ETag` format, the `400`/`428`/`404`/`412`/`409`
      ladder, and that `412` means "re-read and retry" while `409` means "terminal".

## Verification

From the repository root:

```bash
dotnet build Inventory.slnx
dotnet run --project tests/Inventory.Tests/Inventory.Tests.csproj
```

Add checks to `tests/Inventory.Tests/Program.cs` following its conventions (top-level call,
one static function per scenario, `Assert(condition, message)`, existing
`SeedLocation`/`PhysicalStock` helpers, `InternalsVisibleTo` access to `internal` slices) and
update the final `PASS: 15 ...` count line. Drive the transitions through their `Execute`
methods with the validator as an argument, and cover: the full `400`/`428`/`404`/`412`/`409`
ladder, `412` winning over `409` on a stale validator against a confirmed reservation, the
version advancing exactly once per successful transition, an old validator rejected after
each transition, an unrelated stock mutation leaving the validator valid, and
failure-is-mutation-free.

Header emission and status mapping need a live app, because the harness calls `Execute`
directly:

```bash
ASPNETCORE_URLS=http://localhost:5000 dotnet run --project src/Inventory.Api/Inventory.Api.csproj
ID=$(curl -s -X POST localhost:5000/reservations -H 'content-type: application/json' -d '{"sku":"WIDGET","quantity":3}' \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
ETAG=$(curl -is localhost:5000/reservations/$ID | sed -n 's/^ETag: //Ip' | tr -d '\r')
curl -is -X POST localhost:5000/reservations/$ID/cancel -H "If-Match: $ETAG"        # 204, stock restored
curl -is localhost:5000/reservations/$ID                                             # status Cancelled, ETag bumped
curl -is -X POST localhost:5000/reservations/$ID/confirm -H "If-Match: $ETAG"         # 412, stale
curl -is -X POST localhost:5000/reservations/$ID/confirm                             # 428
curl -is -X POST localhost:5000/reservations/$ID/confirm -H 'If-Match: *'             # 400
curl -is -X POST localhost:5000/reservations/$ID/confirm -H 'If-Match: W/"stale"'     # 400
curl -is -X POST localhost:5000/reservations/$ID/confirm -H "If-Match: $ID:99"        # 400 (unquoted)
MISSING=9a7c1d0e-1111-4abc-8def-0123456789ab
curl -is -X POST localhost:5000/reservations/$MISSING/confirm -H "If-Match: \"$MISSING:0\""   # 404, validator matches route id
curl -is -X POST localhost:5000/reservations/not-a-guid/confirm -H 'If-Match: "x:0"'          # 404, route constraint
```

The `204` must be followed by a `GET` showing the bumped `ETag`, and the stale `412` must
leave status and version as the `204` left them.
