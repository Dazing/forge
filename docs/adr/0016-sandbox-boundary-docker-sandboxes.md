# ADR 0016 — Sandbox boundary: Docker Sandboxes, enforced by a guard hook

## Status

Accepted

## Context

This ADR extends **[ADR 0013](0013-autonomy-free-until-merge-sandboxed.md)** (autonomy: free
until merge, sandboxed) — it turns 0013's sandbox *rule* into an *enforced boundary*.

ADR 0013 set the rule — the agent works in a credential-free sandbox, infra is applied only by
pipelines after human merge — but v0 implemented it as convention (a devcontainer omitting cloud
CLIs). Tool absence is not capability absence; nothing prevents host sessions; no egress control.
Meanwhile Docker Sandboxes (GA January 2026) provides microVM isolation with a host-side
credential proxy (secrets never enter the VM) and built-in deny-by-default egress policy, with
first-class Claude Code support.

## Decision

1. **Boundary:** Docker Sandboxes is the primary sandbox for product-repo sessions on every
   host class (desktop laptop or headless server); the hardened devcontainer (egress firewall,
   no credential mounts) is the documented fallback, assigned per host class by spike outcome.
   A mixed fleet is a supported outcome. Nothing in the framework may assume a specific host.
2. **Enforcement:** a plugin SessionStart hook hard-blocks sessions in repos whose committed
   `.forge.json` declares `"sandbox": "required"` unless `FORGE_SANDBOX` is set by an approved
   boundary. `FORGE_SANDBOX_OVERRIDE=1` is the single, loud, documented escape hatch.
3. **Credentials:** per-product fine-grained GitHub PAT (one repo; Contents + Pull requests;
   90-day expiry), delivered via the boundary's secret mechanism. No cloud credentials of any
   kind inside the boundary, ever.
4. **Egress:** Locked Down by default — deny-all plus an explicit starter allowlist (GitHub,
   Anthropic API/telemetry, npm, NuGet). New endpoints are deliberate, reviewable additions.

## Consequences

- The sandbox rule stops being discipline-dependent: forgetting is blocked, overriding is visible.
- Safety is **defense in depth**, not a guarantee: hypervisor/container boundary + credential
  absence + scoped PAT + egress allowlist + human-only merge. Any single layer can fail; together
  the worst-case blast radius of a rogue or prompt-injected session is one repo's feature branches.
- Costs accepted: Docker Sandboxes paid tier; a younger product in the critical path (mitigated
  by the maintained devcontainer fallback); ~2 minutes of PAT setup per product; occasional
  one-line allowlist additions when a product legitimately calls a new external API — which makes
  third-party calls visible decisions.
- The guard's threat model is forgetfulness, not forgery: an agent could set the env var itself.
  Defeating a malicious agent is the job of the credential and egress layers, not the hook.
