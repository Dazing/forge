# Adjust a pending inventory reservation

Kind: feature

Add `PATCH /reservations/{id:guid}` with body `{ "quantity": <positive integer> }`. Implement it as one new reservation slice in `Features/Reservations/AdjustReservationQuantity.cs`, preserve the existing folder and dependency rules, and keep the reservation lookup, eligibility decision, stock-delta check, stock mutation, and reservation mutation in one atomic operation.

A successful adjustment returns `200` with the complete reservation `{ id, sku, quantity, status: "Pending" }`. Increasing reserves only the additional quantity; decreasing releases only the difference; requesting the existing quantity is a successful no-op. Return validation `400` for non-positive quantities, `404` for an unknown reservation, and `409` for terminal reservations, insufficient stock, or stock overflow. Every failure must leave stock and reservation state unchanged.

## Acceptance criteria

- **INV-VSA-001:** Increasing a pending reservation reserves only the additional quantity and returns the updated pending reservation.
- **INV-VSA-002:** Decreasing a pending reservation releases only the difference; later confirmation keeps the adjusted quantity consumed, while later cancellation restores the adjusted quantity exactly once.
- **INV-VSA-003:** An increase whose delta exceeds available stock returns `409` and leaves both reservation quantity and available stock unchanged.
- **INV-VSA-004:** A zero or negative requested quantity returns `400` and leaves reservation and stock unchanged.
- **INV-VSA-005:** Confirmed and cancelled reservations reject adjustment with `409`; an unknown reservation returns `404`; all failures are mutation-free.
- **INV-VSA-006:** Existing inventory receipt, reservation creation, confirmation, and cancellation behavior remains intact, including non-negative stock and case-insensitive SKU identity.
