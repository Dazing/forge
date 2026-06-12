# 0002 — Form factor: plugin + template

**Status:** Accepted

## Context

forge has two kinds of content: process logic that should be identical across every
product, and per-project scaffolding that each product owns. Bundling them one way risks
either duplicating process into every repo or coupling shared process to one project.

## Decision

One repo, `dazing/forge`, that is **both**:

- a **Claude Code plugin** — the process logic (commands, hooks, agents). Installed once;
  improvements propagate to every project automatically.
- a **project template** — cloned to start a product (monorepo skeleton, devcontainer,
  ADR/briefs dirs, CLAUDE.md skeleton).

Process lives in the plugin (shared, versioned); per-project knowledge lives in each
product repo.

## Consequences

- Improving the loop is a single edit to the plugin, reaching all products at once.
- The template can drift from any one product without affecting the shared process.
- The repo carries two halves with different lifecycles; the README must make the split
  obvious.
