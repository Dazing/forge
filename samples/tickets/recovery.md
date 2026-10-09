# Add inventory reservations under recovery

Kind: feature

Implement the reservation behavior described below. The proof harness injects execution failures independently of this text.

## Acceptance criteria

- **INV-REC-001:** Reservation creation reduces available stock and prevents over-reservation.
- **INV-REC-002:** Pending reservations can be confirmed or cancelled, and invalid repeated transitions are rejected.
- **INV-REC-003:** Cancellation restores stock exactly once.
