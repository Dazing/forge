# Consolidate reservation transition policy

Kind: refactor

Remove the genuine duplicated reservation lookup and pending-state eligibility policy in confirmation and cancellation. Express transition eligibility once while preserving all public HTTP and stock behavior.

## Acceptance criteria

- **INV-REF-001:** All existing reservation tests and HTTP behavior remain unchanged.
- **INV-REF-002:** Confirmation and cancellation share one implementation of lookup and pending-state eligibility.
- **INV-REF-003:** Stock restoration remains cancellation-specific and atomic with the state transition.
