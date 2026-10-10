# Review task

Review the implementation of this single supplied local ticket in the target repository, which is your current working directory.

- Ticket ID: {{TICKET_ID}}
- Title: {{TICKET_TITLE}}
- Branch: {{BRANCH}}

<ticket>
{{TICKET_CONTENT}}
</ticket>

This is the same reusable branch sandbox used by the implementer. The selected agent exposes the supplied skill catalog from its global skills directory (`~/.pi/agent/skills/` for Pi, `~/.omp/agent/skills/` for oh-my-pi); read every relevant `SKILL.md` and companion file. Inspect the branch diff and repository context. Check the implementation against every requirement in the supplied local ticket, focusing on correctness, failure paths, security, maintainability, tests, and unintended behavior changes. Do not query or update an external issue tracker.

Fix every issue you find directly on this branch. Run the repository's relevant checks after any fixes and commit all review changes. If no fixes are needed, do not create an empty commit. Do not create another branch. Do not report success if a check fails, a ticket requirement remains unmet, changes remain uncommitted, or an unresolved blocker exists. Explain the failure instead and exit nonzero when possible.

Only after the implementation is complete, the review has no unresolved findings, relevant checks pass, and the worktree is clean, output:

<promise>COMPLETE</promise>
