---
id: low-stock-report
name: low-stock-report
repository: git@github.com:Dazing/forge-test-repo.git
dependsOnTickets: []
baseBranch: main
---

# 01: Low-stock report

Kind: feature

**What to build:** Add `GET /inventory/low-stock` to forge-test-repo so callers can identify SKU/location pairs whose available quantity is at or below their safety-stock threshold. Each entry includes SKU, location, available quantity, safety stock, and shortfall calculated as `max(0, safetyStock - available)`. Include entries exactly at the threshold with a shortfall of 0, sort by SKU and then location, and return an empty collection when no locations qualify. Deliver one complete, read-only feature slice following the source agent instructions and existing feature-slice conventions, with behavioral tests, HTTP verification, and documentation in the existing README.

Preserve uppercase public SKU/location representations. Take a consistent snapshot under the InventoryState lock and map results to explicit HTTP response models rather than exposing persistence records. Do not mutate state, add dependencies, or introduce external persistence.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Acceptance criteria

- [ ] The endpoint returns `200` with entries containing SKU, location, available quantity, safety stock, and shortfall for every SKU/location pair whose available quantity is at or below its safety-stock threshold.
- [ ] Behavioral tests cover stock below, exactly at, and above the threshold: below-threshold entries have shortfall equal to safety stock minus available quantity; exactly-at-threshold entries are included with shortfall 0; above-threshold entries are excluded.
- [ ] Public SKU and location values retain their uppercase representations.
- [ ] Results are sorted deterministically by SKU and then location, independent of insertion order. Behavioral tests include multiple SKUs and multiple locations for the same SKU.
- [ ] The endpoint returns an empty collection when no locations qualify. Behavioral tests cover both empty inventory and inventory with all locations above their thresholds.
- [ ] Results derive from a consistent snapshot taken under the InventoryState lock. HTTP responses expose explicitly mapped response models, never persistence records.
- [ ] Behavioral tests prove reporting leaves inventory and other existing state unchanged, including any existing state version, for both qualifying and empty results. Existing inventory behavior remains intact.
- [ ] Run the existing test executable and API build successfully. Exercise the running endpoint over HTTP with qualifying entries, including an exactly-at-threshold entry, and with no qualifying entries; record observed status codes, response fields, shortfalls, and ordering.
- [ ] Document the endpoint in the existing README, including the response shape, threshold inclusion rule, shortfall calculation, uppercase identifiers, ordering, and empty-result behavior.
- [ ] Follow the source agent instructions and existing feature-slice conventions. Keep the operation read-only and add no dependencies or external persistence.
