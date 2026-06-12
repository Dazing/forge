# 0012 — Session ritual: /start and /compound bookends

**Status:** Accepted

## Context

A low-energy starting threshold is an explicit acceptance criterion, and the compounding
loop only works if sessions reliably open with context and close with distillation.
Relying on discipline to remember both ends is fragile.

## Decision

Every session is bookended by two commands:

- **`/forge:start`** — the AI reads git status, open PRs, open issues, and `SESSION.md`
  (in-flight / blocked / next, written by the previous `/forge:compound`), then proposes
  the session's work **with sizing**.
- **`/forge:compound`** — distills and routes learnings (ADR 0008), updates `SESSION.md`,
  pushes WIP.

A **session-end hook nags** if `/forge:compound` wasn't run.

## Consequences

- `SESSION.md` is the handoff channel between sessions; both commands read/write it.
- v0 ships a **simple, unconditional** SessionEnd reminder; conditional logic that tracks
  whether `/compound` actually ran is deferred (see ADR 0015 / brief 001).
- The two commands are the v0 plugin's core surface, alongside `/forge:grill`.
