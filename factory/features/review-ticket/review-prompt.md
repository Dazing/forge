# Review task

Review the implementation of this single supplied local ticket in its ticket workspace, which is your current working directory.

- Ticket ID: {{TICKET_ID}}
- Title: {{TICKET_TITLE}}
- Branch: {{BRANCH}} (already checked out)
- Base branch: {{BASE_BRANCH}} (the clone's `origin` tip)

<ticket>
{{TICKET_CONTENT}}
</ticket>

This is the same ticket workspace the implementer used. The implementation work is uncommitted, and a prior review iteration's uncommitted corrections are still present. First inspect the branch diff against `origin/{{BASE_BRANCH}}`, the commits ahead of it, and the full worktree status. Continue from the current branch state; do not redo completed work merely because this is a new agent iteration.

The selected agent exposes the supplied skill catalog from its global skills directory (`~/.pi/agent/skills/` for Pi, `~/.omp/agent/skills/` for oh-my-pi). Read only the skills and companion files relevant to this change. Check every ticket requirement, prioritizing observable correctness, failure paths, security, unintended behavior changes, and required verification. Do not query or update an external issue tracker.

Keep the review bounded. Use existing successful evidence when it remains valid. Run each ticket-required check once against the final state, and add another targeted check only for a concrete finding or unsupported runtime claim. Do not perform broad framework research, repeat API launches, or exercise unrelated scenarios without a specific unresolved question.

Local Git reads (`git status`, `git log`, `git diff`, `git rev-parse`) are allowed. You must not create commits. The runner creates the single checkpoint commit for this stage after your report. Never run `git commit` (including `--amend`), `git reset`, `git rebase`, `git cherry-pick`, `git switch`, `git checkout`, `git branch`, `git push`, stash, or delete/mutate remote branches; never run `gh` or `az repos`; never call the GitHub or Azure DevOps API. The runner owns every commit and every remote operation.

Fix every supported issue directly on this branch and leave the fixes uncommitted. After the final fix, run the relevant checks and inspect the complete `git status --short` output without excluding generated directories. Restore unrelated generated changes. Do not report success if a check fails, a ticket requirement remains unmet, or an unresolved blocker exists.

Report exactly one JSON object inside a `<review>` tag, immediately followed by the completion signal:

<review>
{"message": "fix(scope): imperative subject summarizing the reviewed outcome\n\nShort body: findings and their disposition, the exact checks run and their observed results, and any limitation. State explicitly when no changes were needed."}
</review>

`message` is one trimmed string of at most 4000 characters. Line feeds are allowed; other control characters are not. Use a Conventional Commit subject without the ticket ID as scope; when the review needed no file changes, use a `chore` subject and explain that no changes were needed. Never include a `Factory-*:` trailer line (the runner owns commit trailers), and never include credentials, tokens, or secrets.

Do not report success when a check fails, a ticket requirement remains unmet, or an unresolved blocker exists. On failure, explain the blocker in prose and emit neither the `<review>` block nor the completion signal.

Only after the implementation is complete, the review has no unresolved findings, and relevant checks pass, end with:

<promise>COMPLETE</promise>
