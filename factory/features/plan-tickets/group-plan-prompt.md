# Plan the next delivery group

Select at most one supplied delivery group for this cycle. Preserve its exact group ID, ticket IDs, order, and titles. Dependency truth and readiness are already validated by the runner; do not add, remove, or reorder tickets. Return an empty groups array when no group should run.

<delivery-groups>
{{GROUPS}}
</delivery-groups>

Call `submit_handoff` exactly once with `{"groups":[{"groupId":"...","tickets":[{"id":"...","title":"..."}]}]}` or `{"groups":[]}`. Call it only after preserving the supplied identity and ordering exactly. If the tool rejects invalid arguments, correct the arguments and call it again in this turn. After acceptance, stop.
