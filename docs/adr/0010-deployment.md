# 0010 — Deployment: cloud prod, homelab staging

**Status:** Accepted

## Context

Paying customers must never depend on home fiber/power, but the owner has a capable
homelab (Talos K8s via ArgoCD) ideal for dev/staging/demo, and the portfolio budget is
tight ($30–250/mo across all products).

## Decision

- **Prod:** one small managed cloud target (Azure Container Apps or Hetzner VPS w/ k3s —
  finalized at first launch). Customers never depend on Gothenburg fiber/power.
- **Dev/staging/demo:** the homelab Talos K8s cluster via ArgoCD, where tailnet-only is a
  feature.
- The **same container artifact** promotes through both. Budget stays inside $30–250/mo
  across the portfolio.

## Consequences

- The template is container-first (Dockerfiles + compose) so one artifact promotes
  cleanly.
- The specific prod target is deferred to first real launch; the promotion model is fixed.
- Staging runs where tailnet-only isolation is an asset, not a limitation.
