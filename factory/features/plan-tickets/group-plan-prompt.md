# Plan the next delivery group

Select at most one supplied delivery group for this cycle. Preserve its exact group ID, ticket IDs, order, and titles. Dependency truth and readiness are already validated by the runner; do not add, remove, or reorder tickets. Return an empty groups array when no group should run.

<delivery-groups>
{{GROUPS}}
</delivery-groups>

Return exactly one object:
<plan>{"groups":[{"groupId":"...","tickets":[{"id":"...","title":"..."}]}]}</plan>

End with `</plan>`.
