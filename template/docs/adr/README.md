# Architecture Decision Records

An ADR captures a **significant decision** and the reasoning behind it — the "why"
that has to survive long after the diff is forgotten.

## When to write one

Write an ADR when a `/forge:grill` surfaces a decision that **constrains future code**:

- the stack or a new dependency / pattern
- the auth or tenancy model
- a data shape (schema, key strategy, event contract)
- an external service the product now depends on

If it is a feature detail, it does **not** belong here — that pollutes the decision
log. The grill's trigger question is the test: *does this constrain future code?*

## Numbering & format

- Files: `NNNN-kebab-title.md`, zero-padded, monotonic (`0001-...`, `0002-...`).
- One decision per file. ADRs are **immutable**: to change a decision, write a new ADR
  that supersedes the old one and note the supersession in both.
- Structure: **Status** (Proposed / Accepted / Superseded) · **Context** · **Decision** ·
  **Consequences**. Keep it terse — the brief and the code carry the detail.
