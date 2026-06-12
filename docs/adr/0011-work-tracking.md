# 0011 — Work tracking: GitHub Issues + PR per unit

**Status:** Accepted

## Context

Each unit of work needs a backlog home, a place to attach its brief, and a review
artifact — and the AI needs to drive it programmatically. The owner's portfolio-level
tracking already lives in Notion HQ Tasks.

## Decision

Per product repo: **GitHub Issues are the backlog; every M/L unit = a branch + a PR linked
to its issue**, with the brief committed in-repo and referenced from both. The AI works it
via `gh`. **Notion HQ Tasks holds only portfolio-level items** with repo links.

## Consequences

- The PR is the review artifact and the merge gate (ADR 0007); the issue is the backlog item.
- The brief lives in-repo (`docs/briefs/`) and is referenced, not duplicated, into issue/PR.
- Tooling depends on `gh`; commands that use it must degrade gracefully when it is absent
  (v0 host has no `gh` — `/forge:start` skips PR/issue context rather than failing).
