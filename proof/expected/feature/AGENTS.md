# Inventory API agent instructions

- Target .NET 10 with nullable reference types enabled.
- Preserve every HTTP response and reservation/stock behavior.
- Remove duplicated lookup and pending-transition policy from `Confirm` and `Cancel`; transition eligibility must have one implementation.
- Keep mutations atomic and code direct. Do not add dependencies.
- Outside this checkout, read only the supplied standards and acceptance suite under `/factory-inputs/`. Never modify those inputs or access other external files.
- Run the repository-local test executable and API build.
