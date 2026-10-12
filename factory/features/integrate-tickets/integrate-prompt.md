# Reviewed ticket integration

Integrate and review the supplied ticket checkpoints in the current workspace.

- Group: {{GROUP_ID}}
- Branch: {{BRANCH}}
- Task: {{TASK}}

<reviewed-tickets>
{{TICKETS}}
</reviewed-tickets>

<encountered-conflicts>
{{CONFLICT_PATHS}}
</encountered-conflicts>

Resolve every pending merge conflict, stage resolutions with `git add`, and review the combined behavior even when Git merged cleanly. Run relevant verification. Do not commit, change HEAD/branch, push, reset, rebase, or discard reviewed ticket changes. Preserve unrelated behavior. Every encountered conflict needs a concise disposition.

Only after every conflict is resolved, combined review passes, and no conflict markers, generated debris, or unresolved findings remain, call `submit_handoff` exactly once with:

`{"message":"integration review summary and verification","conflicts":[{"path":"path","disposition":"resolution"}]}`

Include one disposition for every encountered conflict. If the tool rejects invalid arguments, correct the arguments and call it again in this turn. Do not submit a handoff while work is incomplete. After acceptance, stop without running more tools or changing files.
