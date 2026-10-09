# Inventory API agent instructions

- Target .NET 10 with nullable reference types enabled.
- Preserve every HTTP response and reservation/stock behavior.
- Remove duplicated lookup and pending-transition policy from `Confirm` and `Cancel`; transition eligibility must have one implementation.
- Keep mutations atomic and code direct. Do not add dependencies or access files outside this checkout.
- Run the repository-local test executable and API build.
