# 0017 — Red-green-refactor as the default implementation discipline

**Status:** Accepted

**Amends:** ADR 0006 (implementation rules), ADR 0007 (review gate).

## Context

ADR 0006 requires acceptance criteria to become tests written *with* the code, and makes
strict TDD an *opt-in* for engine/logic-heavy modules. Opt-in means it rarely happens: an
agent takes the path of least resistance and writes the implementation first, then tests
that ratify whatever the code did. Such tests pass immediately and can never fail — they
rubber-stamp the implementation rather than express intent.

Tests must instead be authored independently of the implementation that follows — sharp,
intentional, derived from the requirements. The one cheap proof that a test was written
that way is that it **failed first** against a missing or stub implementation. Verified
handoff today proves only *green*, which a rubber-stamp test also shows; nothing demands
the *red*.

## Decision

Red-green-refactor is the **default implementation discipline for M and L work**, replacing
ADR 0006's "strict TDD is opt-in" clause:

1. **Default-on for M/L.** Work with behavior worth specifying runs red → green → refactor
   by default. Skipping is the exception and must be stated.
2. **Named opt-out.** A brief may mark a unit or specific parts as `no-TDD: <reason>`
   (glue, UI wiring, config — where red-green adds nothing). The skip is explicit and
   reasoned, never silent.
3. **S is exempt.** Chores keep ADR 0005 lightness: no test requirement, no brief, no
   skip-note.
4. **Red is handoff evidence.** ADR 0006 rule 3 (verified handoff) now requires the **red
   transcript** — the failing assertion output captured against a missing/stub
   implementation — alongside the green run. The red observation is the artifact that
   distinguishes a genuine red-green from a reverse-engineered one.
5. **Refactor rides inside implement.** Improving structure while tests stay green; no new
   artifact, no separate gate.
6. **Review checks test meaningfulness.** The adversarial pre-review (ADR 0007) verifies
   each acceptance criterion maps to a test asserting on observable behavior, and flags
   tests coupled to implementation internals. Red proves a test *can* fail; review proves
   it fails for the right reason.

## Consequences

- The default flips from off to on; the agent must now justify *not* doing red-green, not
  justify doing it.
- Handoff without a red transcript is incomplete by definition — green alone no longer
  satisfies the gate for M/L.
- The review gate gains one dimension (test-meaningfulness); its shape is otherwise
  unchanged.
- **No enforcement tooling** is built now: the discipline rests on stated evidence + the
  review gate, consistent with ADR 0015 (fix the shape, let tooling follow real use).
- ADR 0006 and 0007 are amended by this ADR via a one-line pointer; their text is preserved
  as history.
