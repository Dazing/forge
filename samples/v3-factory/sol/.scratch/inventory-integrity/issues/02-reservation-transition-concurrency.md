---
id: reservations-optimistic-transition-concurrency
name: reservation-transition-concurrency
repository: git@github.com:Dazing/forge-test-repo.git
baseBranch: main
dependsOnTickets: []
---

# Require reservation ETags for confirmation and cancellation

## What to build

Make reservation transitions conditional on the version a caller actually read. `GET /reservations/{id}` returns a strong `ETag` header in the exact form `"<id>:<reservationVersion>"`, including the surrounding double quotes. Both `POST /reservations/{id}/confirm` and `POST /reservations/{id}/cancel` require that exact current value in `If-Match` before changing a pending reservation.

Keep successful transition responses as `204`. Missing `If-Match` returns `428 Precondition Required`. Malformed IDs or invalid headers return `400`; valid requests then distinguish unknown reservations (`404`), stale preconditions (`412`), and non-pending reservations or cancellation stock overflow (`409`). A caller using an old ETag after a successful transition receives `412`, not `409`.

## Context and constraints

Read and follow `AGENTS.md`. The .NET 10 minimal API already implements create, get, confirm, and cancel as separate Reservations capabilities. Each slice may use Data and ASP.NET Core but must not reference another slice. Data owns persistence-shaped records and synchronization only; header parsing, HTTP policy, and response shaping belong in Reservations.

Add an `int Version` to `ReservationRecord`, initialized to `0` on creation. Use a per-reservation counter, not `InventoryState.Version`. Successful confirmation/cancellation increments the reservation version once alongside the existing single global increment. An unrelated receipt, transfer, or mutation to another reservation must not invalidate this reservation's ETag. Creation keeps its existing single global increment and response contract; no new creation-header requirement is introduced.

Define the canonical ETag using the reservation GUID in lowercase `D` format and the version as invariant decimal digits, enclosed in double quotes. GET must snapshot the response representation and ETag from the same locked reservation state; it must not return a representation for one version with a header for another. Preserve the existing GET JSON fields; use a Reservations-owned boundary type for response/header shaping rather than exposing `ReservationRecord` or adding HTTP behavior to Data. Keep any boundary helper independent of individual capability classes to preserve the no-cross-slice-reference rule.

Transition validation contract, in precedence order:

1. Malformed route ID returns `400`, even if `If-Match` is absent. A syntactically valid but unknown GUID, including an unassigned all-zero GUID, remains an unknown entity rather than malformed input.
2. With a valid ID, absent `If-Match` returns `428` before lookup. A present empty/blank or otherwise invalid header returns `400` before lookup.
3. Require one strong quoted validator in the canonical ID/version format. Reject wildcard `*`, weak validators, unquoted values, malformed tokens, and multiple values or validator lists with `400`. A well-formed validator identifying another reservation or version is a mismatch, not malformed syntax.
4. With valid ID/header syntax, lookup returns `404` for an unknown reservation, regardless of whether the token would match some other entity.
5. For a known reservation, compare against its current literal ETag; mismatch returns `412` before checking status or computing restoration quantities.
6. Only a matching ETag proceeds to the pending-status check. A non-pending reservation returns `409`. Cancellation retains its existing mutation-free `409` on stock restoration overflow.
7. A matching pending transition commits and returns `204`.

Make these checks and the transition a single locked operation. Do not let a precondition checked outside the lock authorize a later write. Existing `{id:guid}` constraints on transition routes currently turn malformed GUIDs into routing-level `404`; adjust the transition route/binding boundary so malformed IDs actually receive `400`. Do not unnecessarily change GET's existing invalid-ID behavior.

Migrate all existing confirm/cancel operation callsites and harness scenarios to the new precondition contract; do not retain an unconditional compatibility overload. Existing stock conservation, allocation restoration, and overflow protections remain in force.

No new packages, controllers, services, repositories, external persistence, automatic retries, cross-slice references, inventory ETags, or stock-adjustment capability. This ticket has no dependency on the manual-adjustment ticket.

## Acceptance criteria

- [ ] Reservation creation initializes its resource version to `0`, and lookup returns the quoted canonical `"<id>:0"` ETag together with the unchanged reservation representation from one consistent snapshot. Repeated reads do not mutate state.
- [ ] Both transition endpoints return `400` for malformed route IDs and malformed/weak/wildcard/multiple-value headers; valid IDs with missing headers return `428`. These input failures precede entity lookup, with the malformed-ID precedence specified above.
- [ ] A valid ID and valid header for an unknown reservation return `404`. For a known reservation, a well-formed nonmatching token returns `412` regardless of whether the reservation is pending or terminal.
- [ ] With the current matching ETag, a non-pending reservation returns `409`. Thus, after either successful transition, the old ETag returns `412` and the freshly read ETag returns `409` on a subsequent transition attempt.
- [ ] A pending reservation with a current matching ETag confirms or cancels with `204`. Its resource version advances once, and a subsequent GET exposes the changed ETag and new status. Verify confirmation and cancellation on separate pending reservations; terminal reservations cannot transition again.
- [ ] Confirmation preserves consumed stock. Cancellation restores every allocation exactly once; overflow anywhere in restoration returns `409` with no partial restoration or version increment.
- [ ] Every successful transition increments global `InventoryState.Version` exactly once as well as its resource version once. Every `400`, `428`, `404`, `412`, or `409` leaves stock, allocations, reservation status/version, and global version unchanged.
- [ ] Two workers using the same pending ETag cannot both commit. Exactly one transition succeeds; the loser receives `412` without mutation, even if it requested the other transition.
- [ ] Unrelated stock writes and changes to a different reservation do not change this reservation's ETag or cause an otherwise current precondition to fail.
- [ ] README API table and reservation documentation explain GET ETags, mandatory transition `If-Match`, successful `204`, `428/400/404/412/409` outcomes and precedence, and read-again behavior after a stale token. All existing operation callsites and lifecycle checks use the new contract without compatibility shims.

## Verification

Work test-first in `tests/Inventory.Tests/Program.cs`. Add failing checks before implementation for per-resource versioning, both transition paths, all input failures, and the complete precedence ladder. Deliberately combine conditions: malformed header plus unknown ID must be `400`; valid header plus unknown ID must be `404`; stale header plus terminal status must be `412`; fresh header plus terminal status must be `409`. Cover missing headers independently (`428`), including unknown but syntactically valid IDs. Assert full before/after state equality for failures rather than only status outcomes.

Use separate newly created reservations to demonstrate ETag changes after confirmation and cancellation. Keep old tokens and prove their post-transition rejection. Cover a well-formed token for another reservation, unrelated receipt/other-reservation changes, cancellation overflow across allocations, and competing confirm/cancel operations using the same token. Update the existing lifecycle and stock-conservation checks to supply current preconditions rather than removing their original invariants.

Run from the target repository root:

```sh
dotnet run --project tests/Inventory.Tests/Inventory.Tests.csproj
dotnet build src/Inventory.Api/Inventory.Api.csproj
```

Exercise actual HTTP routing and headers against the running API with an explicit local URL. Create a reservation, GET and capture its ETag, and use that header to confirm with `204`. GET again and observe the changed ETag/status. Reuse the old token against confirm and cancel and expect `412`; use the fresh terminal token and expect `409`. Repeat the lifecycle with a separate pending reservation and cancellation, verifying inventory restoration. Exercise missing `If-Match` (`428`), malformed transition GUID (`400`, not `404`), malformed/weak/wildcard/list validators (`400`), and a valid unknown GUID with a syntactically valid validator (`404`). This HTTP smoke is required because the current executable harness primarily calls operation methods and would not by itself prove route/header behavior.

Retain deterministic regression checks in the existing harness, document observed smoke results, and remove throwaway smoke scaffolding. No commits, pushes, merges, or runner lifecycle changes are part of this ticket.
