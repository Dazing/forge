# Brief 001 — Forge v0 spine

**Size:** L · **Status:** approved (design interview, June 2026) · **Branch:** `v0-spine`

## Problem

The forge framework exists only as a design record
(`/home/dazing/Git/dazing/dazing-hq/context/business/forge-framework.md`, the authority for all
"why" questions — read it first). Build the minimal spine so the owner can start product #1 with
it within days.

## Approach

One repo, two halves: a Claude Code **plugin** (process) and a project **template** (starting
point). Dogfood from commit one: the 15 design decisions become this repo's own ADRs.

### Repo layout (deliverable)

```
forge/
├─ .claude-plugin/
│  ├─ plugin.json              # name "forge", description, version 0.1.0
│  └─ marketplace.json         # so `/plugin marketplace add dazing/forge` works
├─ commands/
│  ├─ start.md                 # /forge:start
│  ├─ grill.md                 # /forge:grill
│  └─ compound.md              # /forge:compound
├─ hooks/
│  └─ hooks.json               # SessionEnd reminder to run /compound (v0: simple unconditional nudge)
├─ docs/
│  ├─ adr/0001-*.md … 0015-*.md  # the 15 decisions from the design record, one ADR each
│  └─ briefs/001-v0-spine.md   # this file
├─ template/                   # copied (degit/cp) to start a new product
│  ├─ CLAUDE.md                # project conventions skeleton + forge loop pointers
│  ├─ SESSION.md               # state file: In flight / Blocked / Next (empty skeleton)
│  ├─ README.md
│  ├─ docker-compose.yml       # api + web + postgres
│  ├─ .devcontainer/devcontainer.json
│  ├─ .gitignore               # covers dotnet + node
│  ├─ docs/adr/README.md       # numbering + when-to-write rules
│  ├─ docs/briefs/README.md    # brief format (problem/approach/out-of-scope/acceptance)
│  ├─ api/                     # ASP.NET Core minimal API, .NET 10, + xUnit test project
│  └─ web/                     # React + Vite + TypeScript
├─ INBOX.md                    # process-learning inbox (empty, with usage note)
└─ README.md                   # what forge is, install, start-a-product, the loop in 10 lines
```

### Plugin command content (the process logic, distilled from the design record)

**IMPORTANT:** before authoring plugin files, verify the current plugin/command/hook file formats
against the official docs (https://code.claude.com/docs/en/claude-code/plugins and related pages).
Do not guess schemas from memory.

- **`/forge:start`** — session opener. Instructs Claude to: read SESSION.md, `git status`,
  open PRs and issues (graceful if `gh` is absent); summarize where things stand; propose the
  session's unit of work **with an S/M/L size classification** (S chore → no grill; M task →
  mini-grill 3–6 questions; L → full grill; trigger for L: "does this constrain future code?");
  wait for one-keystroke confirmation before doing anything.
- **`/forge:grill`** — gate 1. Instructs Claude to interview the user **one question at a time,
  with a recommended answer per question**, walking dependencies in order, to extract the user's
  design — never to propose a finished plan for rubber-stamping. Output: a brief in
  `docs/briefs/NNN-<slug>.md` (Problem / Approach / Out of scope / Acceptance criteria, sized),
  plus an ADR in `docs/adr/` if a decision surfaced that constrains future code. Ends by asking
  for explicit approval of the brief. Must also state the implementation rules that bind the
  subsequent work: brief-bound scope (stop and surface contradictions, never improvise),
  acceptance criteria become tests (M/L), verified handoff (build+test+lint run and behavior
  demonstrated before review).
- **`/forge:compound`** — session closer. Instructs Claude to: review the session for signal
  (corrections, friction, repeated instructions, decisions); propose 0–5 candidate learnings,
  each pre-routed — project convention → this repo's CLAUDE.md, significant decision → ADR,
  process/framework lesson → forge INBOX.md; apply only what the user approves; update
  SESSION.md (in flight / blocked / next); leave the tree committed or cleanly stashed.

### Template specifics

- `api/`: scaffold with `dotnet new` — minimal API (`net10.0`), one example endpoint
  (`GET /api/health`), one xUnit test project with a passing test wired into `dotnet test`.
  Solution file at `template/` root or `api/` root — keep it conventional.
- `web/`: scaffold with `npm create vite@latest` (react-ts). One example fetch of `/api/health`.
  Keep the scaffold stock; no UI framework in v0.
- `.devcontainer/devcontainer.json`: dotnet 10 + node LTS (image or features). **Sandbox rule
  (ADR 0013): no cloud tooling** — no az/terraform/kubectl features, and a comment in the file
  stating this is deliberate.
- `CLAUDE.md` skeleton: short — points at the forge loop (sizing, gates, implementation rules),
  has empty "Conventions" and "Architecture notes" sections for /compound to grow.
- CI workflow, walkthrough/pre-review machinery: **out of scope** (v0 defers to weeks 2–3).

### ADRs 0001–0015

One per numbered section of the design record, same order, same titles. Format: Status /
Context / Decision / Consequences — terse, the design record already has the prose. Do not
copy the file wholesale; each ADR stands alone.

## Out of scope (v0)

- `/forge:new` scaffolding command (v0: README documents `degit dazing/forge/template`)
- Pre-review agent, guided-walkthrough machinery, CI/CD workflow templates
- Conditional SessionEnd hook logic (state-tracking whether /compound ran)
- Any local-LLM integration; any Notion integration

## Acceptance criteria

1. `dotnet test` passes inside `template/api` (or solution root); `npm run build` passes inside
   `template/web` — run both to prove it.
2. Plugin files conform to the documented Claude Code plugin schema (verified against live docs,
   noted in the handoff report).
3. All 15 ADRs present and individually readable; brief 001 (this file) committed.
4. README covers: install the plugin, start a product from the template, the loop in ≤10 lines.
5. All work on branch `v0-spine`, committed with clear messages. **Do not push, do not merge** —
   merge is the human gate.

## Verified handoff

Report: build/test output for api and web, the final `git log --oneline` of the branch, the repo
tree, and anything where reality contradicted this brief (surfaced, not improvised around).
