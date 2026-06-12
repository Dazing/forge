# 0004 — Artifact taxonomy: three tiers, one job each

**Status:** Accepted

## Context

Decisions, units of work, and standing conventions have different granularities and
lifespans. Collapsing them into one kind of document means either the decision log fills
with feature detail or durable "why" gets lost in transient notes.

## Decision

Three artifacts, one job each:

| Artifact | Granularity | Lifespan | Job |
|---|---|---|---|
| **ADR** (`docs/adr/NNNN-*.md`) | A significant decision (stack, auth model, data shape, new dependency/pattern) | Immutable, numbered | The "why" that survives |
| **Brief** (`docs/briefs/NNN-*.md`) | One unit of work: problem, approach, out-of-scope, acceptance | Archived when shipped | The contract implementation is bound to |
| **CLAUDE.md** | Project conventions + "how we work here" | Living, curated | What the AI must know every session |

ADRs are written **only** when a grill surfaces a real decision.

## Consequences

- Feature detail never pollutes the decision log; the trigger "does this constrain future
  code?" gates ADR creation.
- Briefs are disposable once shipped; ADRs are immutable and superseded, not edited.
- CLAUDE.md is curated by a human (via `/forge:compound`), keeping always-loaded context lean.
