# 0008 — Compounding: session-end distill + scope routing

**Status:** Accepted

## Context

A framework only improves if lessons from each session are captured and land somewhere
durable. Relying on the human to remember to do this guarantees it won't happen
consistently, and dumping every learning into one file makes none of them actionable.

## Decision

`/forge:compound` closes every session (hook-reminded, not discipline-dependent). The AI
reviews the session for signal — corrections, friction, decisions, things it was told
twice — and proposes **0–5 candidate learnings, each pre-routed by scope**:

- Project convention → that repo's **CLAUDE.md**
- Significant decision → **ADR**
- Process/framework lesson → **INBOX.md in forge** (batch-applied to the plugin weekly)

The human approves/rejects each in one pass. **Curation is deliberately a human act.**

## Consequences

- A session-end hook nags if `/forge:compound` wasn't run (see ADR 0012).
- Routing is decided by the AI but disposition by the human; nothing is applied unapproved.
- Framework lessons accumulate in forge's INBOX and are applied deliberately, not live.
