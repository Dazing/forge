# Pull-request content task

Produce the content of a draft pull request for this single supplied local ticket. You are in the ticket workspace, which is your current working directory.

- Ticket ID: {{TICKET_ID}}
- Title: {{TICKET_TITLE}}
- Ticket branch: {{BRANCH}} (currently checked out)
- Base branch: {{BASE_BRANCH}} (the pull request target, `origin/{{BASE_BRANCH}}`)

<ticket>
{{TICKET_CONTENT}}
</ticket>

Inspect the committed change set: `git log origin/{{BASE_BRANCH}}..HEAD`, `git diff origin/{{BASE_BRANCH}}...HEAD`, and `git status --porcelain`. The status must be clean after review. Each commit in that range is a runner-created stage checkpoint carrying `Factory-Ticket`, `Factory-Attempt`, `Factory-Stage`, `Factory-Outcome`, `Factory-Changes`, and `Factory-Agent-Log` trailers; use the stage messages and trailer values as the source of the change narrative, and never invent commits the log does not show. The selected agent exposes the supplied skill catalog from its global skills directory (`~/.pi/agent/skills/` for Pi, `~/.omp/agent/skills/` for oh-my-pi); read relevant `SKILL.md` files only when the repository's language conventions matter to the content.

Produce content only:

- `title`: a short pull-request title for the change set.
- `body`: Markdown with the following sections in order: `### ELI5`, `### Play-by-play`, `### Verification`, and `### Known limitations`.

Body requirements:

- Start with `### ELI5`: in 2–4 short sentences, explain what changed, why it was needed, and what users or developers can now do or observe. Use everyday language, avoid jargon and syntax details, and keep simplifications accurate.
- Follow with `### Play-by-play`: explain the codebase changes in concise numbered steps. Start with the entry point or trigger and follow the important calls, branches, transformations, and state changes through to the result. For declarative code, explain how the changed parts are interpreted or connected instead.
- Explain what changed relative to the base branch and why it matters, not just what each line says. Cover every consequential change, grouping repetitive operations and boilerplate rather than listing every file or line. For documentation or configuration changes without an execution flow, explain their effects in a logical order.
- Name relevant symbols and cite `path:line` references from the current source where available. Read surrounding code, callers, dependencies, and tests only as needed to establish the changed behavior; do not expand into an unrelated repository tour.
- Attach consequential error paths, side effects, async behavior, and edge cases to the relevant step. Keep each step to 1–3 short sentences and define unfamiliar terms briefly on first use.
- Distinguish code-established behavior from inferred intent. Do not invent guarantees, runtime results, or reasons unsupported by the ticket or change set.
- In `### Verification`, report only checks actually performed and their observed results; distinguish inspected test coverage from executed tests. State when verification was not run.
- In `### Known limitations`, state known limitations or missing evidence that matters; if none were identified, say so without implying exhaustive proof.
- Keep the explanation focused on this change set. Do not reproduce large code blocks, narrate the inspection process, or add unrelated refactoring advice.

You have no authority to execute anything remote. Do not run `git push`, create, delete, merge, or switch branches, stage, commit, modify, delete, or create any file, run `gh` or `az repos`, or call the GitHub or Azure DevOps API. The runner performs every Git and provider API operation deterministically from your output.

After the title and body satisfy every requirement, call `submit_handoff` exactly once with:

`{"title":"Short pull-request title","body":"Markdown summary."}`

Both values must be non-empty. If the tool rejects invalid arguments, correct the arguments and call it again in this turn. After acceptance, stop without running more tools or changing files.
