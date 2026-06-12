---
description: Close a forge session — review it for signal, propose 0–5 pre-routed candidate learnings, apply only what the user approves, update SESSION.md, and leave the tree committed or cleanly stashed.
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(git stash:*), Bash(git branch:*)
---

You are running **compound** — the session closer. Compounding is how forge improves with
every session. Review what happened, distill the signal, route each learning to the right
home, and hand off cleanly. **Curation is a human act:** you propose, the user disposes.

## 1. Review the session for signal

Look back over this session and over `git diff` / `git log` for the kinds of signal that
are worth keeping:

- **Corrections** the user made to your approach or output.
- **Friction** you hit — something that was harder or more surprising than it should be.
- **Repeated instructions** — anything you were told more than once (a strong sign it
  belongs in a durable place).
- **Decisions** taken — choices that will constrain or guide future work.

## 2. Propose 0–5 candidate learnings, each PRE-ROUTED

Propose between **zero and five** learnings. Zero is a valid and common outcome — do not
manufacture learnings to fill the list. For each one, state it in a sentence and **route
it by scope**:

- **Project convention** ("how we do it here") → this repo's **`CLAUDE.md`** (Conventions
  or Architecture notes section).
- **Significant decision** that constrains future code → a new **ADR** in `docs/adr/`.
- **Process / framework lesson** (about the forge loop itself, not this product) → the
  **forge `INBOX.md`** — i.e. the INBOX in the *forge plugin/framework repo*, not this
  product repo. State it as an inbox-bound item; if you cannot write to the forge repo
  from here, print the line for the user to paste, clearly labeled for forge's INBOX.

Present them as a short, numbered list with the proposed destination on each. Do **not**
apply anything yet.

## 3. Apply only what the user approves

Let the user approve, reject, or edit each candidate in one pass. Then apply **only** the
approved ones to their routed destinations:

- CLAUDE.md edits → append to the right section.
- ADRs → next zero-padded `NNNN`, Status/Context/Decision/Consequences.
- forge INBOX items → as above.

Rejected candidates are dropped without argument.

## 4. Update SESSION.md

Rewrite `SESSION.md` so the next `/forge:start` has a running start:

- **In flight** — work started but not finished (what, where, what's left).
- **Blocked** — anything waiting on a decision, dependency, or the user.
- **Next** — the most likely next unit(s) of work.

Keep it short — it's a handoff note, not a log.

## 5. Hand off cleanly

Leave the working tree in a clean state:

- If there is uncommitted work that forms a coherent unit, commit it with a clear message
  (on the feature branch, never directly on the default branch). If the user prefers,
  cleanly `git stash` it instead.
- Never leave the tree in a half-staged, ambiguous state.
- Report the final state: branch, what was committed or stashed, and what's open.

The session-end hook nags if `/forge:compound` wasn't run — running this command is how
you answer that nag.
