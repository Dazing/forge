---
kind: command
name: plan
---
# plan

Produce a structured plan for the issue.

## Steps
1. Read the issue requirements, acceptance criteria, and technical
   constraints.
2. Inspect the checked-out repository at the base SHA.
3. Derive a minimal, conventional approach.
4. Derive the acceptance checks, expected paths, and conflict keys.
5. Flag database, authentication, CI-contract, and deployment risk.
6. Record ambiguities with their impact and a safe assumption.

## Output
The structured plan that conforms to `schemas/plan.schema.json`.
