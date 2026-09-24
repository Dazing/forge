---
kind: command
name: repair
---
# repair

Repair a failed implementation, CI, or review outcome within one bounded
cycle.

## Steps
1. Read the failure: the review verdict, CI result, or CI failure.
2. Diagnose the cause from the evidence. Do not change the acceptance criteria
   unless the review explicitly requires it.
3. Make the smallest fix that resolves the specific finding or failure.
4. Do not add scope.

## Output
The structured implementation result that conforms to
`schemas/implementation.schema.json`.
