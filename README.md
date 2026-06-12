# forge

An AI-assisted engineering framework for solo, greenfield product builds. forge is two
things in one repo: a **Claude Code plugin** (the process — a two-gate design loop) and a
**project template** (a .NET + React monorepo to start a product from).

The point is **ownership without typing every line**: the AI extracts *your* design,
builds strictly against an approved brief, and the loop compounds — every session leaves
the framework and the project a little sharper. No vibe-coding, no rubber-stamping an
AI's plan.

## The loop (in 10 lines)

1. `/forge:start` — read state, propose one unit of work, sized **S / M / L**.
2. **S** = chore → just do it. **M** = mini-grill (3–6 Qs). **L** = full grill.
3. `/forge:grill` — the AI interviews *you*, one question at a time, to extract your design.
4. It writes a **brief** (problem / approach / out-of-scope / acceptance) — and an **ADR**
   if a decision constrains future code.
5. **Gate 1:** you approve the brief. No code before this.
6. Implement — brief-bound; acceptance criteria become tests; verified handoff.
7. Review — AI pre-review, then a guided walkthrough of the diff.
8. **Gate 2:** you merge the PR. Merge is sign-off; only a human merges.
9. `/forge:compound` — distill the session into learnings, route them, update `SESSION.md`.
10. The two gates are the only mandatory human acts; everything between is the AI's lane.

## Install the plugin

```text
/plugin marketplace add dazing/forge
/plugin install forge@dazing-forge
```

This adds the commands `/forge:start`, `/forge:grill`, and `/forge:compound`, plus a
session-end hook that reminds you to run `/forge:compound`. (For local development of the
plugin itself, you can also point Claude Code at a checkout with `claude --plugin-dir
/path/to/forge`.)

## Start a product from the template

The template lives in [`template/`](./template). v0 has no scaffolding command — copy it
out with `degit`:

```bash
npx degit dazing/forge/template my-product
cd my-product
# api: dotnet test   ·   web: npm install && npm run build
git init && git add -A && git commit -m "Start from forge template"
```

You get: a .NET 10 minimal API (`api/`, with a `GET /api/health` endpoint and an xUnit
test), a React + Vite + TypeScript front end (`web/`, fetching `/api/health`), a
`docker-compose.yml` (api + web + postgres), a no-cloud-tooling devcontainer, and
`docs/adr/` + `docs/briefs/` with their conventions. Read the product's `CLAUDE.md` for
the loop and the implementation rules, then run `/forge:start`.

## How this repo is built

forge is **project #1** for forge — it is dogfooded. The 15 design decisions behind the
framework are recorded as this repo's own ADRs in [`docs/adr/`](./docs/adr); each unit of
work gets a brief in [`docs/briefs/`](./docs/briefs). Framework lessons learned while
building real products land in [`INBOX.md`](./INBOX.md) and are batch-applied.

## Layout

```
.claude-plugin/   plugin.json + marketplace.json
commands/         /forge:start · /forge:grill · /forge:compound
hooks/            SessionEnd → reminder to run /forge:compound
docs/adr/         the 15 framework decisions, one ADR each
docs/briefs/      units of work (001 = the v0 spine)
template/         the product starting point (copied via degit)
INBOX.md          process-learning inbox for framework lessons
```
