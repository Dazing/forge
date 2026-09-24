---
kind: skill
name: patch-discipline
---
# patch-discipline

Reusable guidance for producing a minimal, publishable patch.

- Edit only the paths the plan expects. An unexpected path requires an
  explanation in the implementation result.
- Keep the diff minimal: no reformat, no drive-by refactors, no churn
  unrelated to the change.
- The patch must apply without fuzz to the expected base SHA.
- No tree-escaping symlinks, submodules, or credential material in the patch.
- Every acceptance criterion has recorded evidence.
