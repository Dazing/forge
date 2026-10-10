# Supplied local tickets

These are the only tickets available in this invocation. Each ticket includes its stable local ID, exact deterministic branch, host path for identification only, and full Markdown content. The IDs are not GitHub issue numbers: do not query, update, or close an external issue tracker.

<supplied-tickets>
{{TICKETS}}
</supplied-tickets>

Already completed ticket IDs in this invocation: {{COMPLETED_TICKET_IDS}}

# Task

First inspect the target repository, which is your current working directory. The selected agent exposes the supplied skill catalog from its global skills directory (`~/.pi/agent/skills/` for Pi, `~/.omp/agent/skills/` for oh-my-pi); read each relevant `SKILL.md` and every companion file it references before reasoning about the work.

Build a dependency graph for the supplied pending tickets. A ticket is blocked when it depends on code or a decision introduced by another supplied ticket, or when concurrent work would overlap enough to create likely merge conflicts. Choose up to four unblocked tickets that can be implemented concurrently. Select only tickets shown above, never a completed ticket. Preserve each selected ticket's ID, title, and branch exactly. Do not modify the repository.

If every pending ticket is blocked, select the single candidate with the fewest or weakest dependencies so the invocation can make progress. An empty selection is valid only when no supplied pending tickets exist.

# Output

Return exactly one JSON plan wrapped in `<plan>` tags and no other `<plan>` block:

<plan>
{"tickets":[{"id":"0123456789abcdef","title":"Exact supplied title","branch":"sandcastle/ticket-0123456789abcdef"}]}
</plan>
