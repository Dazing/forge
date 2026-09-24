---
kind: skill
name: repo-conventions
---
# repo-conventions

Reusable guidance for keeping a change conventional to the checked-out
commit.

- Inspect the existing code before editing. Reuse its names, patterns, and
  module layout.
- Do not introduce a second convention beside an established one.
- Keep changes minimal. A change that adds behavior it was not asked for is
  out of scope.
- Match the repository's error-handling, logging, and test conventions.
- Run the repository's own checks. If they fail, diagnose before changing.
