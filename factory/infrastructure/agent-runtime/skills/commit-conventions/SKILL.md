---
name: commit-conventions
description: Conventional Commits rules for this project. Use when committing code — message format, type selection, scope naming. Referenced by build-prd and code-review.
---

# Commit Conventions

[Conventional Commits](https://www.conventionalcommits.org/) — enforced in code review.

## Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

## Type prefix (required)

| Type | Use when |
|------|----------|
| `feat` | New user-facing capability |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or correcting tests (no production code change) |
| `docs` | Documentation only |
| `style` | Formatting, whitespace, semicolons — no logic change |
| `build` | Build system, dependencies, CI config |
| `ops` | Deployment, infrastructure, monitoring |
| `chore` | Maintenance that doesn't fit above |

## Rules

- Description starts **lowercase**.
- Description does **not** end with a period.
- Type must match the change — `feat` for a test-only change is wrong (use `test`); `fix` for a restructure is wrong (use `refactor`).
- **Scope** is a project area (`api`, `persistence`, `ui`, `auth`), not a ticket ID. `feat(PROJ-123):` is wrong; `feat(api):` is right.
- **Breaking changes** must be flagged: either `!` before the colon (`feat!: remove endpoint`) or a `BREAKING CHANGE:` footer.

## One commit per slice (default)

When building through the `build-prd` / `build-prd-solo` pipeline, commit after each slice's refactor phase. The commit message type is usually `feat` (new capability) or `fix` (correcting behavior). Scope is the feature folder name.

```
feat(users): add create-user endpoint with validation
fix(orders): reject cancellation when already shipped
test(orders): add property test for OrderState invariants
refactor(orders): extract pricing to static calculator
```
