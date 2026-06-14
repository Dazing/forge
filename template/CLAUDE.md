# CLAUDE.md

Project conventions for this product. Built with **forge** — the AI-assisted
engineering framework. The process (sizing, gates, implementation rules) lives in
the forge plugin; this file holds what is true for *this* repo and grows as the
project teaches us things.

## The forge loop (pointer)

Every unit of work runs the two-gate loop. The plugin commands drive it:

- **`/forge:start`** — open the session: read `SESSION.md`, git status, open PRs/issues;
  propose the next unit of work with an **S / M / L** size; wait for your go-ahead.
  - **S** (chore) → no grill, just implement.
  - **M** (task within existing patterns) → mini-grill, 3–6 questions.
  - **L** (new pattern / dependency / data shape / external service) → full grill.
- **`/forge:grill`** — gate 1. Claude interviews you one question at a time to extract
  *your* design, then writes a brief in `docs/briefs/` (and an ADR if a decision
  surfaced). **You approve the brief before any code is written.**
- **implement** — strictly against the approved brief. Rules below.
- **`/forge:compound`** — close the session: distill learnings, route them
  (convention → here, decision → ADR, process lesson → forge INBOX), update `SESSION.md`.

## Implementation rules (these bind every session)

1. **Brief-bound scope** — implement only what the approved brief says. If reality
   contradicts the brief, **stop and surface it**; a deviation is a design conversation,
   never an improvisation.
2. **Red-green-refactor by default (M/L)** — acceptance criteria become tests written
   *before* the implementation, derived from requirements, not reverse-engineered from
   code. The default is red → green → refactor for any work with behavior worth
   specifying. A brief may mark a unit or specific parts `no-TDD: <reason>` (glue, UI
   wiring, config) — the skip is explicit, never silent. S chores are exempt.
3. **Verified handoff** — build + tests + lint run and the behavior is demonstrated
   (endpoint exercised, UI checked) before review is requested. For M/L, handoff includes
   the **red transcript** (tests failing against a missing/stub implementation) alongside
   the green run — green alone does not prove a test can fail. Report results honestly.

The only mandatory human acts are **brief approval** and **PR merge**. Everything between
is the AI's lane.

## Sandbox (these bind every session)

This repo declares `.forge.json` → `"sandbox": "required"` (forge ADR 0013/0016).
Sessions run inside a **credential-free boundary** (Docker Sandboxes or the hardened
fallback devcontainer), which exports `FORGE_SANDBOX`. The forge plugin's `SessionStart`
guard hook warns loudly if a session starts on the bare host.

- **Never** add cloud tooling, mount cloud config (`~/.azure`, `~/.aws`, `~/.kube`,
  `~/.config/gcloud`), or pass cloud env vars into the boundary. Infra is code in PRs
  that pipelines apply after a human merge — the agent proposes infra, never applies it.
- The boundary's only credential is a **per-repo scoped GitHub PAT** (`GH_TOKEN`).
- Setup, egress allowlist, and PAT guide live in [`SANDBOX.md`](./SANDBOX.md).
- If the guard hook fires (you're on the bare host), **stop** and tell the user to
  restart inside the boundary. The only sanctioned bypass is `FORGE_SANDBOX_OVERRIDE=1`
  (loud, discouraged).

## Stack

- `api/` — ASP.NET Core minimal API (.NET 10) + xUnit tests. Solution: `api/Forge.slnx`.
- `web/` — React + Vite + TypeScript. Dev proxies `/api` to the API.
- `docker-compose.yml` — api + web + postgres for local full-stack runs.

## Conventions

<!-- /forge:compound grows this. Project-specific "how we do it here" rules. -->

## Architecture notes

<!-- /forge:compound grows this. Significant structural facts worth knowing every session. -->
