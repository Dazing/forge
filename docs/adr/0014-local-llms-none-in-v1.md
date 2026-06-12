# 0014 — Local LLMs: none in v1

**Status:** Accepted

## Context

The owner has a dual-P40 Ollama homelab setup and an interest in local models. The
temptation is to wire them into the loop early for cost savings. But a weak model placed
in a judgment role (e.g. a reviewer) quietly lowers the quality of the gate it sits in.

## Decision

The loop runs **entirely on Claude Code** in v1. The dual-P40 Ollama setup stays a
separate homelab interest. Revisit at v2 once the loop is stable; the natural slot then is
**cheap bulk work, not judgment work** — a weak reviewer that's part of the gate quietly
lowers the gate.

## Consequences

- v0/v1 has **no local-LLM integration** (explicitly out of scope for the spine).
- Reviewer and grill roles stay on a strong model, protecting gate quality.
- A future v2 may add local models for bulk/non-judgment tasks once the loop is proven.
