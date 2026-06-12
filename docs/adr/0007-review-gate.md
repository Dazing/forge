# 0007 — Review gate: AI pre-review, then guided walkthrough

**Status:** Accepted

## Context

The owner wants deep insight into what was built without re-reading every line, and a real
check on AI output before it merges. A self-review by the implementer's own voice is weak;
a raw diff dump gives insight but no triage.

## Decision

The review gate has two passes:

1. An **adversarial AI review** (a separate reviewer role, not the implementer's voice)
   hunts bugs and brief-deviations; confirmed findings are fixed first.
2. The human gets a **guided walkthrough**: the diff is presented brief-first — the agreed
   approach, where each part lives, and the spots of least confidence. The human drills in
   wherever warranted.

Human findings are tagged **fix-now** or **learning** (learning → compound step).
**Merge = sign-off; no merge without the human.**

## Consequences

- The implementer does not review its own work in its own voice.
- The walkthrough gives ownership-level insight without line-by-line reading.
- v0 defers the pre-review agent and walkthrough machinery to weeks 2–3 (see ADR 0015);
  the gate's *shape* is fixed now, the tooling arrives driven by real use.
