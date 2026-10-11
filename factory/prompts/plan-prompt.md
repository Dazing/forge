# Supplied local tickets

These are the only tickets available in this invocation. Each ticket includes its stable local ID, normalized name, exact title, the canonical SSH repository URL it targets, its base branch, host path for identification only, and full Markdown body. The IDs are not provider issue numbers: do not query, update, or close an external issue tracker.

<supplied-tickets>
{{TICKETS}}
</supplied-tickets>

Already completed ticket IDs in this invocation: {{COMPLETED_TICKET_IDS}}

# Task

Your current working directory is the runner checkout, not any ticket repository. Ticket repositories are cloned later, after selection, so you cannot inspect them. Reason from ticket content only.

Build a dependency graph for the supplied pending tickets. A ticket is blocked when it depends on code or a decision introduced by another supplied ticket, or when concurrent work would overlap enough to create likely merge conflicts. Choose up to four unblocked tickets that can be implemented concurrently. Select only tickets shown above, never a completed ticket. Preserve each selected ticket's ID and title exactly; do not echo, invent, or choose branches, workspaces, or repositories. Do not modify the repository you are in.

If every pending ticket is blocked, select the single candidate with the fewest or weakest dependencies so the invocation can make progress. An empty selection is valid only when no supplied pending tickets exist.

# Output

Return exactly one JSON plan wrapped in `<plan>` tags and no other `<plan>` block:

<plan>
{"tickets":[{"id":"0123456789abcdef","title":"Exact supplied title"}]}
</plan>
