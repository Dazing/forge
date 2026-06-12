# 0005 — Work sizing: three sizes, AI-classified

**Status:** Accepted

## Context

A full design interview for a one-line copy change is waste; shipping a new data shape
with no grill is reckless. The loop's rigor must scale with the work's weight, and the
classification should cost the human almost nothing.

## Decision

The AI classifies each unit of work at intake into one of three sizes; the human confirms
in one keystroke:

- **S — Chore** (rename, dep bump, copy change): no grill. Implement + light human glance.
- **M — Task** (new endpoint/feature within existing patterns): mini-grill, 3–6 targeted
  questions; brief is a bullet list.
- **L — Decision** (new pattern, dependency, data shape, or external service): full grill
  → brief + ADR if a decision surfaced.

The trigger that pushes a unit to **L** is the question **"does this constrain future
code?"**

## Consequences

- `/forge:start` proposes the size; the human only confirms or overrides.
- The size selects the depth of `/forge:grill` and whether an ADR is even in play.
- Misclassification is cheap to correct (one keystroke) and surfaces early, before work.
