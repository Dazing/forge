# Add inventory reservations

Kind: feature

Add reservation creation, confirmation, and cancellation to the inventory API. Creation atomically removes available stock, must reject non-positive quantities and over-reservation, and returns a stable reservation identifier. Only pending reservations can transition. Cancelling restores stock exactly once; confirming does not restore stock.

## Acceptance criteria

- **INV-FEAT-001:** `POST /reservations` creates a pending reservation and reduces available stock by its quantity.
- **INV-FEAT-002:** A request exceeding available stock is rejected and leaves stock unchanged.
- **INV-FEAT-003:** Confirming a pending reservation succeeds and a repeated or conflicting transition is rejected without changing stock.
- **INV-FEAT-004:** Cancelling a pending reservation restores stock exactly once and repeated cancellation is rejected.
- **INV-FEAT-005:** Non-positive reservation quantities are rejected without changing stock.
