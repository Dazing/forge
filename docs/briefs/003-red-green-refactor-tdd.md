# 003 — Red-green-refactor as the default implementation discipline

**Size:** L · **Status:** approved

## Problem

ADR 0006 already requires "acceptance criteria become tests, written *with* the code,"
and makes strict TDD an *opt-in* for engine/logic-heavy modules. In practice that lets the
agent take the path of least resistance: write the implementation, then write tests that
ratify whatever the code happened to do. Those tests pass on day one and can never fail —
they rubber-stamp the implementation instead of expressing intent.

The tests must be authored **independently of the implementation that follows** — sharp,
intentional, and derived from the requirements / acceptance criteria, not reverse-
engineered from the code. The only cheap proof that a test was written that way is that it
**failed first** (red) against a missing or stub implementation, before any code made it
pass (green). Today nothing demands that proof: verified handoff shows *green*, which is
exactly what a rubber-stamp test also shows.

## Approach

Promote **red-green-refactor** from opt-in to the **default discipline for M/L work**, and
make the red step an evidence requirement, not an honor-system claim.

- **Default-on for M/L.** Any unit of work with behavior/logic worth specifying runs
  red → green → refactor by default. The default flips from off to on; *skipping* becomes
  the exception that must be stated.
- **Named opt-out.** A brief may mark a unit (or specific parts — glue, UI wiring, config)
  as `no-TDD: <one-line reason>`. Theater is avoided where red-green adds nothing
  (e.g. red-green-refactoring a `fetch` call); the skip is explicit and reasoned, never
  silent.
- **S is exempt.** Chores keep their ADR 0005 lightness — no test requirement, no brief,
  no skip-note.
- **Red is evidence.** Verified handoff (ADR 0006 rule 3) grows from "tests pass" to:
  *tests failed as expected against no/stub implementation (the red transcript captured),
  then passed once implemented (the green transcript).* The red observation — the actual
  failing assertion output, captured before the implementation existed — is the artifact
  that distinguishes a real red-green from a reverse-engineered one.
- **Refactor rides inside implement.** Refactor means improving structure while tests stay
  green. It produces no new artifact and gets no separate gate.
- **Review gains a test-meaningfulness check.** The adversarial pre-review (ADR 0007)
  additionally verifies that each acceptance criterion maps to a test asserting on
  **observable behavior**, and flags tests coupled to implementation internals (which
  break on refactor and prove nothing). Red proves a test *can* fail; the review proves it
  fails *for the right reason*.

### Where it lands

- **New ADR 0017** owns the red-green-refactor discipline and records *why* the rule
  changed (tests must be sharp and requirement-derived). ADR 0006 and 0007 get a one-line
  "amended by 0017" pointer — history is append-only, not rewritten.
- **Living instructions edited in place:** the template `CLAUDE.md` implementation rules,
  and the `grill.md` binding-rules statement / `start.md` sizing text, so the discipline
  binds the very next session.

## Out of scope

- **No enforcement tooling** — no hook that parses the red transcript or fails CI when no
  red was observed. v0 relies on stated handoff evidence + the review gate (consistent with
  ADR 0015: fix the shape now, tooling arrives with real use).
- **No change to S** — chores stay exempt, no-test, no-brief.
- **No coverage targets or test-framework mandate** — the stack already picks the framework.
- **No separate refactor gate.**

## Acceptance criteria

- [ ] ADR 0017 exists (`docs/adr/0017-*.md`), Accepted, stating: red-green-refactor is the
      default for M/L, the named `no-TDD` opt-out, S exemption, red-as-handoff-evidence, and
      the review test-meaningfulness check.
- [ ] ADR 0006 and ADR 0007 each carry a one-line "amended by 0017" pointer; their original
      text is otherwise preserved.
- [ ] Template `CLAUDE.md` implementation rule 2 reflects red-green-refactor default-on for
      M/L with the named opt-out, and rule 3 (verified handoff) requires the red + green
      transcripts.
- [ ] `commands/grill.md` binding-rules statement (the rules read aloud at approval) and
      `commands/start.md` sizing text reflect the new default and the S exemption.
- [ ] The `no-TDD: <reason>` opt-out convention is documented where a brief author will see
      it (grill output guidance).
- [ ] No enforcement tooling, no coverage target, and no change to S are introduced.
