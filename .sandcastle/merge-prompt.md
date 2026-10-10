# Merge task

Merge these reviewed branches into the target repository's current branch:

{{BRANCHES}}

They implement these supplied local tickets:

{{TICKETS}}

The selected agent exposes the supplied skill catalog from its global skills directory (`~/.pi/agent/skills/` for Pi, `~/.omp/agent/skills/` for oh-my-pi); read every relevant `SKILL.md` and companion file before acting. For each exact branch listed above, merge it with `git merge <branch> --no-edit`. Resolve conflicts by inspecting both sides and preserving all supplied local-ticket requirements. Do not query or update an external issue tracker. After all branches are merged, run the repository's relevant checks and fix any integration failures. Commit conflict resolutions or integration fixes as needed; do not create a redundant summary commit when the merges already produced commits.

Do not report success if any listed branch was not merged, a merge or check failed, conflicts remain, changes remain uncommitted, or an unresolved blocker exists. Explain the failure instead and exit nonzero when possible.

Only after every listed branch is merged, relevant checks pass, and the worktree is clean, output:

<promise>COMPLETE</promise>
