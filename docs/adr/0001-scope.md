# 0001 — Scope

**Status:** Accepted

## Context

forge needs a target shape to be designed well. The owner runs a micro-SaaS portfolio:
greenfield, solo, 2–4 week MVPs, ~10–20 hrs/week. A framework fitted to brownfield or
team constraints would carry weight this work never pays for.

## Decision

forge serves the **micro-SaaS portfolio builds first**: greenfield, solo, short MVPs. The
many-small-projects shape is exactly what makes a compounding process pay off fastest.
Patterns may later be ported to day-job/consultancy work, but forge is **not** designed
for brownfield or team constraints.

## Consequences

- Every later decision optimizes for solo greenfield speed and compounding, not team
  coordination or legacy migration.
- Day-job applicability is a possible future export, not a design constraint now.
- If a feature only makes sense for teams/brownfield, it is out of scope by default.
