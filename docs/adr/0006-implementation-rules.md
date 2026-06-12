# 0006 — Implementation rules: brief-bound + verified handoff

**Status:** Accepted

## Context

Once a brief is approved, the AI works largely unsupervised until the merge gate. Without
explicit rules, an agent will quietly expand scope, skip tests, or claim success it never
demonstrated — exactly the failure modes that make AI implementation untrustworthy.

## Decision

Three rules bind all implementation after gate 1:

1. **Scope** — implement only what the brief says. If reality contradicts the brief,
   **stop and surface it**; a deviation is a design conversation, not an implementation
   detail.
2. **Tests** — the brief's acceptance criteria become tests, written with the code. M/L
   work does not hand off without them. (Strict TDD is an opt-in per brief for
   engine/logic-heavy modules.)
3. **Verified handoff** — before requesting review: build + tests + lint run, behavior
   demonstrated (endpoint exercised, UI checked), results reported honestly.

## Consequences

- These rules are stated by `/forge:grill` at approval time so they bind the very next
  step, and restated in the template's `CLAUDE.md`.
- "Surface, don't improvise" makes contradictions visible instead of silently absorbed.
- A handoff without real build/test/lint evidence is incomplete by definition.
