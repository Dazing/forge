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

Return exactly:
<integration>
{"message":"integration review summary and verification","conflicts":[{"path":"path","disposition":"resolution"}]}
</integration>
<promise>COMPLETE</promise>

Do not emit completion while conflicts, conflict markers, dirty generated debris, or unresolved review findings remain.
