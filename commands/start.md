---
description: Open a forge session — read state, summarize where things stand, propose the next unit of work with an S/M/L size, and wait for a one-keystroke go-ahead.
argument-hint: "[optional: what you want to work on]"
disable-model-invocation: true
allowed-tools: Read, Bash(git status:*), Bash(git log:*), Bash(git branch:*), Bash(gh pr list:*), Bash(gh issue list:*), Bash(gh auth status:*), Glob
---

You are opening a **forge** working session. Forge runs a two-gate design loop per unit
of work: grill → implement → review → compound. Your job right now is only the opening
ritual: orient, summarize, and propose **one** next unit of work with a size. Do **not**
start implementing and do **not** start a grill yet.

## 1. Gather state (read-only)

Run these and read the results. Tolerate failure of any single one — never block on it.

- Read `SESSION.md` if it exists (In flight / Blocked / Next — written by the last
  `/forge:compound`). This is your primary signal for what comes next.
- `git status` (working tree, current branch) and `git log --oneline -5` (recent history).
- `git branch --show-current`.
- **Open PRs and issues — only if `gh` is available.** First check `gh auth status`
  (or `command -v gh`). If `gh` is missing or unauthenticated, **skip it silently** and
  note "gh unavailable — PR/issue context skipped" in your summary. Never fail the
  command because `gh` is absent. When it is available: `gh pr list` and
  `gh issue list`.
- Skim `CLAUDE.md` for project conventions and any in-flight context.

If the user passed an argument, treat it as their steer toward what to work on.

## 2. Summarize where things stand

Give a tight briefing (a few lines, not an essay):

- Current branch and whether the tree is clean or dirty.
- What `SESSION.md` says is in flight / blocked / next.
- Open PRs and issues if you have them.
- Anything that looks unfinished or risky (uncommitted work, a half-done branch).

## 3. Propose ONE unit of work, sized

Pick the single most sensible next unit (honor the user's steer if given, else
SESSION.md "Next", else the most valuable open thread). Classify its size and say why:

- **S — Chore** (rename, dep bump, copy change, config tweak): no grill. You will just
  implement it with a light human glance at the end. Exempt from TDD (ADR 0017).
- **M — Task** (a new endpoint or feature *within existing patterns*): a **mini-grill**,
  3–6 targeted questions. Brief is a short bullet list.
- **L — Decision** (introduces a new pattern, dependency, data shape, or external
  service): a **full grill** → brief + an ADR if a decision surfaced. The trigger
  question that pushes something to L is: **"does this constrain future code?"** If yes,
  it is L.

M/L implementation runs **red-green-refactor by default** (ADR 0017): tests are written
red-first from the requirements, with a named `no-TDD: <reason>` opt-out for parts with no
behavior worth specifying. S chores are exempt.

State the size, the one-line reason, and what the next step will be (`/forge:grill` for
M/L; direct implementation for S).

## 4. Wait

End by asking for a **one-keystroke confirmation** to proceed (e.g. "y to proceed, or
tell me to pick something else"). Do **not** take any action — no edits, no branches, no
grill — until the user confirms. The session's work does not begin without their go-ahead.
