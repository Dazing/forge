# 0013 — Autonomy: free until merge, sandboxed

**Status:** Accepted · enforced by **[ADR 0016](0016-sandbox-boundary-docker-sandboxes.md)**
(sandbox boundary: Docker Sandboxes + guard hook)

## Context

The loop's value comes from the AI working unsupervised between the two gates, but
unsupervised access to cloud credentials, prod, secrets, or billing is unacceptable risk.
The boundary must be drawn so autonomy is wide but blast radius is bounded.

## Decision

The AI **autonomously** branches, commits, pushes to feature branches, opens/updates PRs,
and runs tests. **Reserved for the human:** brief approval, PR merge, and anything
touching prod, secrets, billing, or data deletion.

**Sandbox constraint:** implementation runs inside per-project **devcontainers with no
cloud credentials** — no `az`, no `terraform`, no kubeconfig mounted. The agent gets the
repo + a scoped GitHub token + the local toolchain only. Infra changes happen exclusively
as code in PRs that CI/ArgoCD apply after human merge: **the agent proposes
infrastructure; pipelines apply it.**

## Consequences

- The template's `devcontainer.json` deliberately ships **no cloud tooling**, with a
  comment stating this is intentional — a reviewer should not "helpfully" add `az`/`kubectl`.
- The agent cannot touch prod even by mistake; infra is reviewable code, applied post-merge.
- Autonomy is wide (all of feature-branch git + tests) but bounded at the two gates.
