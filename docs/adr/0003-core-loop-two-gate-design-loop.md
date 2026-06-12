# 0003 — Core loop: two-gate design loop

**Status:** Accepted

## Context

The owner wants strong ownership of the technical solution and deep insight into the
implementation, without writing every line — and explicitly rejects both uncontrolled
vibe-coding and spec-driven AI vibe-coding (rubber-stamping an AI's plan).

## Decision

Per unit of work, run a four-phase loop with exactly **two human gates**:

1. **GRILL** — the AI interviews the human to extract *their* design (intent, constraints,
   approach, out-of-scope). Output: a brief, and an ADR if warranted. **Gate 1: human
   approves the brief.**
2. **IMPLEMENT** — AI builds strictly against the approved brief.
3. **REVIEW** — AI pre-review, then guided walkthrough. **Gate 2: human merges the PR.**
4. **COMPOUND** — session learnings distilled and routed.

The grill is **generative** (extracts the human's design), not reactive (editing an AI
plan).

## Consequences

- The two gates are the only mandatory human acts; everything between is the AI's lane.
- Quality depends on the grill genuinely extracting the human's design, not presenting one
  for approval — this shapes the `/forge:grill` command's hard rules.
- Phases 1 and 4 each get a dedicated command; the loop is the spine the rest hangs on.
