---
id: transfer-stock-between-locations
name: transfer-stock-between-locations
repository: git@github.com:Dazing/forge-test-repo.git
dependsOnTickets: []
baseBranch: main
---

# 01: Transfer stock between locations

Kind: feature

**What to build:** Add `POST /inventory/{sku}/transfers` to forge-test-repo so callers can move stock between two existing locations for an existing SKU. The request body contains sourceLocation, destinationLocation, and quantity. Only stock above the source location’s safety-stock floor can be transferred. Return the transferred quantity and updated source and destination stock using uppercase SKU/location representations. Deliver one complete feature slice following the source agent instructions and existing feature-slice conventions, with behavioral tests, HTTP verification, and documentation in the existing README.

Validate positive integer quantity, nonblank location names, and distinct source/destination locations using case-insensitive identity. Do not create missing SKUs or locations implicitly. Perform validation against state and the transfer atomically under the single InventoryState lock; preserve total stock and both locations’ safety-stock values. Reject insufficient transferable stock or destination integer overflow before any mutation. Increment the state version exactly once on success. Map results to explicit HTTP response models rather than exposing persistence records. Add no dependencies or external persistence.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Acceptance criteria

- [ ] The endpoint accepts sourceLocation, destinationLocation, and a positive integer quantity, and returns a successful response containing the transferred quantity, uppercase SKU and source/destination location identifiers, and updated stock for both locations.
- [ ] A successful transfer decreases source stock and increases destination stock by exactly the requested quantity, preserves total stock and both safety-stock values, and increments the state version exactly once.
- [ ] Transfer eligibility and both stock updates occur atomically under the single InventoryState lock. All failure paths leave inventory, safety-stock values, state version, and other existing state unchanged.
- [ ] The source can transfer exactly its stock above the safety-stock floor, leaving stock at the floor. A request exceeding that amount, or any positive transfer when source stock is at or below its floor, returns HTTP `409` without mutation. Behavioral tests cover these boundaries.
- [ ] SKU and location lookup use existing case-insensitive identity conventions. Behavioral tests prove mixed-case identifiers resolve existing stock and successful responses use uppercase identifiers.
- [ ] Non-positive quantities, non-integer quantities, blank source or destination names, and source/destination names identifying the same location case-insensitively return HTTP `400` without mutation. Behavioral tests include identical names differing only in case.
- [ ] Unknown SKU, unknown source location, and unknown destination location return HTTP `404` without mutation or implicit creation. Behavioral tests cover each missing entity independently.
- [ ] A transfer that would overflow destination integer stock returns HTTP `409` without mutation, including no source debit or version increment. Behavioral tests cover a destination reaching the maximum integer value successfully and a transfer exceeding it.
- [ ] Behavioral tests cover successful transfers, safety-stock boundaries, case-insensitive identity, invalid inputs, missing entities, overflow, and mutation-free failures. Existing inventory and reservation behavior remains intact.
- [ ] Behavioral tests exercise competing transfers from the same source with combined demand exceeding transferable stock: only transfers affordable at their atomic commit succeed, conflicting requests return `409`, the source never crosses its safety-stock floor, total stock is conserved, and version increments equal the number of successful transfers.
- [ ] Follow the source agent instructions and existing feature-slice conventions. HTTP responses use explicit response models and do not expose persistence records. Add no dependencies or external persistence.
- [ ] Run the existing test executable and API build successfully. Exercise the running endpoint over HTTP for success and representative `400`, `404`, and `409` cases; record observed responses and confirm updated stock, uppercase identifiers, and mutation-free failures.
- [ ] Document the endpoint in the existing README, including request and response shapes, case-insensitive identity and uppercase representations, safety-stock limits, atomicity, and `400`/`404`/`409` error behavior.
