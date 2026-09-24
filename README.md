# Local Agentic Software Factory

Design and planning for a local-first, single-developer agentic software factory.

## What it is

An automated pipeline that moves GitLab issues through planning, implementation, CI repair, independent review, merge, and release — driven by disposable agent containers and local model endpoints, with GitLab as the source of truth.

## Two operating modes

- **Jarvis** — interactive, low-latency ticket drafting on the NVIDIA machine. Developer reviews and approves tickets in GitLab.
- **Autonomous factory** — ready issues flow end-to-end: plan → implement → CI repair → review → merge → staging deploy → release qualification.

## Key invariants

- GitLab is authoritative for all state (issues, MRs, pipelines, releases, notifications).
- Agent work runs in fresh disposable containers with no production credentials.
- Max two implementation tickets active; a third slot reserved for review/recovery.
- `main` deploys to staging automatically; production requires explicit human approval.
- No public ingress — all control surfaces bind to tailnet/internal VLAN.
- Strix Halo purchase blocked until cloud proof-of-concept and hardware evidence gates pass.

## Contents

- [`docs/agentic-software-factory-plan.md`](docs/agentic-software-factory-plan.md) — decision, operating model, architecture, and scope.
- [`docs/technical-design.md`](docs/technical-design.md) — implementable V1 design: topology, trust boundaries, network flows, service contracts.
- [`docs/plans/`](docs/plans/) — phased execution plans (A–H): PoC skeleton, GitLab network, repo contract, ready-to-MR, review-gated merge, scheduler/recovery, release factory, backup/restore.

## Status

Proposed. Cloud proof of concept first; hardware gate before Strix Halo purchase.
