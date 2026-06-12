# 0015 — Bootstrap: minimal v0, dogfooded

**Status:** Accepted

## Context

It's tempting to build the whole framework up front. But the right shape of the
pre-review agent, walkthrough machinery, and CI templates is unknown until the loop is
used on a real product — and building them speculatively risks building the wrong thing.

## Decision

Build the **spine only**, then let usage grow the rest:

- **v0 plugin:** `/forge:start`, `/forge:grill`, `/forge:compound`.
- **v0 template:** .NET + React monorepo skeleton, devcontainer, `docs/adr/` +
  `docs/briefs/`, CLAUDE.md skeleton.
- The forge repo is **project #1** — these decisions become its ADRs 0001+; the design
  record then becomes a one-page pointer.
- Pre-review/walkthrough machinery and CI/CD templates arrive in **weeks 2–3**, driven by
  what `/forge:compound` surfaces while building the first real product.

## Consequences

- v0 deliberately omits: the `/forge:new` scaffolding command (README documents `degit`),
  the pre-review agent, walkthrough machinery, CI/CD templates, conditional SessionEnd
  hook logic, and any local-LLM or Notion integration.
- This ADR and brief 001 define the v0 boundary; later work is justified by real friction,
  not speculation.
- Dogfooding from commit one means forge's own history is the first test of the loop.
