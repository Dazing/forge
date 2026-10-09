# Prevent repeated cancellation restock

Kind: bug

Cancelling the same reservation twice currently increases available stock twice. Correct the transition while preserving creation, first cancellation, and confirmation behavior.

## Acceptance criteria

- **INV-BUG-001:** Cancelling a pending reservation restores its quantity exactly once.
- **INV-BUG-002:** Cancelling an already cancelled reservation is rejected and leaves stock unchanged.
- **INV-BUG-003:** Confirmed reservations remain non-cancellable and do not restore stock.
