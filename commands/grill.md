---
description: Gate 1 of the forge loop — interview the user one question at a time to extract THEIR design, then write a brief (and an ADR if a decision surfaced) and ask for explicit approval before any code is written.
argument-hint: "[the unit of work to grill]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(git status:*), Bash(ls:*)
---

You are running the **grill** — gate 1 of the forge loop. The grill is **generative**:
your job is to extract the *user's* design (their intent, constraints, approach, and
out-of-scope), not to invent a design and ask them to approve it. You are interviewing a
senior engineer who wants to own the technical solution. Pull their thinking out; do not
substitute yours.

**The cardinal rule: never present a finished plan for rubber-stamping.** If you catch
yourself about to write "Here's my plan, approve it?" — stop. The brief is *theirs*,
assembled from their answers.

## How to interview

1. **One question at a time.** Ask a single question, wait for the answer, then ask the
   next. Never batch a numbered list of questions into one message. Never race ahead.
2. **Walk dependencies in order.** Start from the decision everything else hangs on
   (problem → shape of the solution → data/contracts → boundaries → acceptance). Let each
   answer determine the next question. Don't ask about details that an earlier answer
   might make irrelevant.
3. **Give a recommended answer with every question.** For each question, state your
   recommendation and one line of reasoning, then invite them to override it. Format each
   question like:

   > **Q:** <the question>
   > *Recommendation:* <your suggested answer> — <why, in one line>.

   This keeps momentum and lowers the starting threshold while leaving the decision
   theirs. A senior dev can accept with a keystroke or correct you.
4. **Probe, don't pad.** Match depth to size. **M (mini-grill): 3–6 questions.** **L
   (full grill):** as many as the decision needs, but no ritual questions whose answer
   you already know from the codebase. Read `CLAUDE.md`, existing ADRs, and the relevant
   code first so you don't ask what the repo already answers.
5. **Surface, don't smooth.** If two answers conflict, or an answer contradicts an
   existing ADR or convention, say so and ask them to resolve it. Tensions are the point.

Cover, in dependency order: **the problem** (what's wrong / missing, why now) · **the
approach** (the shape they want) · **data shapes and contracts** if any · **out of
scope** (what this unit explicitly does *not* do) · **acceptance criteria** (how we know
it's done — these will become tests for M/L).

## Output: the brief

When you have enough to write their design down — not before — assemble it into a brief.

- Determine the next number: look in `docs/briefs/` and use the next zero-padded `NNN`.
- Write `docs/briefs/NNN-<kebab-slug>.md` with a header line noting **size (S/M/L)** and
  **status: draft**, then these sections:
  - **Problem** — from their answers.
  - **Approach** — the shape they chose.
  - **Out of scope** — the boundaries they drew.
  - **Acceptance criteria** — the done-checklist (becomes tests for M/L).
- Keep it sized: a tight bullet list for M, fuller prose for L.

## Output: an ADR, only if a decision surfaced

If the grill surfaced a decision that **constrains future code** — a new pattern,
dependency, data shape, auth/tenancy model, or external service — also write an ADR:

- Next zero-padded `NNNN` in `docs/adr/`, file `NNNN-<kebab-title>.md`.
- Sections: **Status** (Accepted) · **Context** · **Decision** · **Consequences**. Terse.
- If nothing that constrains future code came up, **do not** write an ADR. Feature detail
  never goes in the decision log.

## Ask for approval, then state the binding rules

Do not consider gate 1 passed until the user explicitly approves. After writing the
brief (and ADR), present the path(s) and ask for **explicit approval of the brief** — a
clear yes, not silence. Tell them to edit it directly or tell you what to change if it's
not right; loop until they approve.

Once they approve, flip the brief's status to **approved** and state the rules that now
bind the implementation (these are non-negotiable and define the AI's lane until gate 2):

1. **Brief-bound scope** — implement only what the approved brief says. If reality
   contradicts the brief, **STOP and surface it** as a design conversation; never
   improvise around it, never silently expand scope.
2. **Acceptance criteria become tests** — for M/L, the work does not hand off without
   tests covering the acceptance criteria, written with the code.
3. **Verified handoff** — before review you will run build + tests + lint and demonstrate
   the behavior (exercise the endpoint, check the UI), reporting results honestly.

Then stop. Implementation is the next step, not part of the grill.
