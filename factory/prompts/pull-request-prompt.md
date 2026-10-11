# Pull-request content task

Produce the content of a draft GitHub pull request for this single supplied local ticket. You are in the ticket workspace, which is your current working directory.

- Ticket ID: {{TICKET_ID}}
- Title: {{TICKET_TITLE}}
- Ticket branch: {{BRANCH}} (currently checked out)
- Base branch: {{BASE_BRANCH}} (the pull request target, `origin/{{BASE_BRANCH}}`)

<ticket>
{{TICKET_CONTENT}}
</ticket>

Inspect the committed change set: `git log origin/{{BASE_BRANCH}}..HEAD`, `git diff origin/{{BASE_BRANCH}}...HEAD`, and `git status --porcelain`. The status must be clean after review. The selected agent exposes the supplied skill catalog from its global skills directory (`~/.pi/agent/skills/` for Pi, `~/.omp/agent/skills/` for oh-my-pi); read relevant `SKILL.md` files only when the repository's language conventions matter to the content.

Produce content only:

- `title`: a short pull-request title for the change set.
- `body`: a Markdown summary of what changed and why, the verification performed, and any known limitations.

You have no authority to execute anything remote. Do not run `git push`, create, delete, merge, or switch branches, stage, commit, modify, delete, or create any file, run `gh`, or call the GitHub API. The runner performs every Git and GitHub operation deterministically from your output.

Return exactly one JSON object wrapped in `<pull-request>` tags and no other `<pull-request>` block. Both values must be non-empty:

<pull-request>
{"title":"Short pull-request title","body":"Markdown summary."}
</pull-request>

Then end with:

<promise>COMPLETE</promise>
