# Briefs

A brief is the **contract for one unit of work** — the output of `/forge:grill` and the
thing implementation is bound to. It is written from *your* design (extracted in the
grill), approved by you at gate 1, and archived once the work ships.

## Numbering

- Files: `NNN-kebab-slug.md`, zero-padded, monotonic (`001-...`, `002-...`).
- One unit of work per brief. Reference it from the issue and the PR.

## Format

Every brief has these sections (sized to the work — a bullet list for M, fuller for L):

- **Problem** — what's wrong / missing and why it matters now.
- **Approach** — how we intend to solve it. The shape, not the line-by-line.
- **Out of scope** — what this unit explicitly does *not* do, so scope can't creep.
- **Acceptance criteria** — the checklist that says "done". For M/L these **become tests**.

Add a one-line header noting size (**S / M / L**) and status (draft / approved / shipped).

## The rules a brief carries

Once approved, the brief binds the implementation:

1. **Brief-bound scope** — build only what's here; contradictions are surfaced, not improvised.
2. **Acceptance criteria become tests** (M/L).
3. **Verified handoff** — build + test + lint pass and behavior is demonstrated before review.
