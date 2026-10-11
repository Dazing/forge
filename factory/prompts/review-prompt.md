# Review task

Review the implementation of this single supplied local ticket in its ticket workspace, which is your current working directory.

- Ticket ID: {{TICKET_ID}}
- Title: {{TICKET_TITLE}}
- Branch: {{BRANCH}} (already checked out)
- Base branch: {{BASE_BRANCH}} (the clone's `origin` tip)

<ticket>
{{TICKET_CONTENT}}
</ticket>

This is the same ticket workspace the implementer used, and a prior review iteration may already have committed fixes. First inspect the branch diff against `origin/{{BASE_BRANCH}}`, recent commits, and the full worktree status. Continue from the current branch state; do not redo completed work merely because this is a new agent iteration.

The selected agent exposes the supplied skill catalog from its global skills directory (`~/.pi/agent/skills/` for Pi, `~/.omp/agent/skills/` for oh-my-pi). Read only the skills and companion files relevant to this change. Check every ticket requirement, prioritizing observable correctness, failure paths, security, unintended behavior changes, and required verification. Do not query or update an external issue tracker.

Keep the review bounded. Use existing successful evidence when it remains valid. Run each ticket-required check once against the final state, and add another targeted check only for a concrete finding or unsupported runtime claim. Do not perform broad framework research, repeat API launches, or exercise unrelated scenarios without a specific unresolved question.

Local Git reads (`git status`, `git log`, `git diff`, `git rev-parse`) and local commits are allowed. Never run `git push`, delete or mutate remote branches, run `gh`, or call the GitHub API: the runner owns every remote operation. Do not create or switch branches.

Fix every supported issue directly on this branch. After the final fix, run the relevant checks, inspect the complete `git status --short` output without excluding generated directories, restore unrelated generated changes, and commit all review changes. If no fixes are needed, do not create an empty commit. Do not report success if a check fails, a ticket requirement remains unmet, changes remain uncommitted, or an unresolved blocker exists. Explain the failure instead and exit nonzero when possible.

Once the implementation is complete, the review has no unresolved findings, relevant checks pass, and the worktree is clean, stop optional investigation and output:

<promise>COMPLETE</promise>
