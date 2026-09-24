---
kind: command
name: review
---
# review

Review a merge request from a fresh context.

## Steps
1. Read the issue, plan, diff, the repository at the head SHA, and the CI
   results.
2. Do not read the implementation transcript.
3. Assess each acceptance criterion against the diff and CI evidence.
4. Record findings with actionable evidence.
5. Issue a verdict bound to `reviewed_sha`.

## Output
The structured review that conforms to `schemas/review.schema.json`.
