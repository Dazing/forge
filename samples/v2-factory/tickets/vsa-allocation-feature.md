---
name: vsa-allocation-feature
repository: git@github.com:Dazing/forge-test-repo.git
baseBranch: main
---

# Reallocate a pending reservation across fulfillment locations

Kind: feature

Add `PUT /reservations/{id:guid}/allocations` with body `{ "quantity": <positive integer>, "destinationPostalCode": "<non-blank string>" }`. Implement the dense capability under `Features/Reservations/ReallocateReservation/` using the existing location-aware state directly. Keep the allocation calculation pure, use explicit mappings at the HTTP, persistence, calculation, and fulfillment-routing boundaries, and call the supplied routing API exactly once for a syntactically valid pending reservation.

Snapshot the reservation, relevant stock, and global state version under the state lock; release the lock before the routing call and calculation; then compare and atomically commit under the lock. Configure the typed routing client from `FULFILLMENT_ROUTING_BASE_URL` with a 500 ms timeout and no retries. A successful operation returns `200` with the complete pending reservation. Return `400` for non-positive quantity or blank postal code, `404` for an unknown reservation, `409` for a terminal reservation, insufficient stock, or a stale snapshot, `502` for routing non-success or a semantically malformed payload, and `504` for routing timeout. Every failure is mutation-free. An unchanged quantity and calculated allocation is a successful no-op that does not increment the state version.

## Acceptance criteria

- **INV-ALLOC-001:** Reallocation follows routing priority, respects safety stock, returns deterministic mapped allocations, and changes stock only by the old/new allocation delta.
- **INV-ALLOC-002:** Reallocation can increase or decrease quantity; subsequent confirmation keeps the final allocation consumed and cancellation restores the final allocation exactly once.
- **INV-ALLOC-003:** Insufficient allocatable stock returns `409` with reservation, location stock, and version unchanged.
- **INV-ALLOC-004:** Non-positive quantity, blank postal code, unknown reservation, and terminal reservation return their specified statuses without calling routing or mutating state.
- **INV-ALLOC-005:** Routing non-success, malformed payload, and timeout map to `502`, `502`, and `504` respectively with no mutation.
- **INV-ALLOC-006:** A concurrent state change detected after routing returns `409` and does not apply a stale allocation decision.
- **INV-ALLOC-007:** Existing inventory receipt, creation, lookup, confirmation, cancellation, case normalization, safety-stock, and conservation behavior remains intact.
