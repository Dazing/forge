# Brief 002 — Sandbox enforcement

**Size:** L · **Status:** approved (June 2026) · **Depends on:** brief 001 (v0 spine) merged

## Problem

ADR 0013 declares the sandbox rule ("agent runs in a credential-free container, no cloud
tooling") but v0 only implements it as a convention: a devcontainer that politely omits cloud
CLIs. Nothing forces a session into the sandbox, tool absence is not capability absence (an
agent can install `az` in seconds), and there is no egress control. The boundary must become
enforced, not remembered.

## Approach

Adopt **Docker Sandboxes** (GA Jan 2026, microVM isolation, host-side credential proxy,
built-in egress policy) as the primary boundary, with the v0 devcontainer as documented
fallback. Keep a hard-block guard hook regardless of boundary tech — no sandbox stops a
habitual `claude` on the host; only the hook does.

1. **Spike first (go/no-go), host-agnostic:** the framework must work the same from any
   machine — a laptop (macOS/Windows/Linux, Docker Desktop) or Jarvis (headless Ubuntu,
   standalone Linux/KVM install, driven over SSH+tmux). Validate Docker Sandboxes on both
   host classes: laptop is the documented-and-expected case; headless-over-SSH is the
   unconfirmed one. Claude Code inside, workspace sync back to the host's repo checkout.
   Go/no-go **per host class**: any class where it fails uses the hardened devcontainer
   fallback below — the guard hook accepts either boundary, so a mixed fleet (e.g. sandbox
   on laptop, devcontainer on Jarvis) is a supported outcome, not a compromise.
2. **Guard hook (plugin):** SessionStart hook. If the repo has `.forge.json` with
   `"sandbox": "required"` and `FORGE_SANDBOX` is unset → **hard block** with instructions
   for entering the sandbox. `FORGE_SANDBOX_OVERRIDE=1` proceeds but announces itself loudly
   in the transcript. Each approved boundary sets `FORGE_SANDBOX=<docker-sandbox|devcontainer>`.
3. **Repo marker:** template ships `.forge.json` (`"sandbox": "required"`) — the requirement
   is a committed property of the repo. HQ/forge-dev sessions are unaffected by construction.
4. **GitHub credentials:** per-product **fine-grained PAT**, scoped to that one repo
   (Contents + Pull requests, read/write; nothing else; 90-day expiry). Delivered via the
   boundary's secret mechanism — Docker Sandboxes' proxy/secrets manager (token never
   materializes in the VM); `containerEnv`/local env file (git-ignored) for the fallback.
   Blast radius of a rogue session: one repo's branches/PRs; main is protected by the merge gate.
5. **Egress:** **Locked Down** policy by default — deny-all plus a forge starter allowlist
   (GitHub, api.anthropic.com + statsig/sentry, registry.npmjs.org, api.nuget.org),
   maintained as a documented `sbx policy` setup; mirrored as an init-firewall adaptation in
   the fallback devcontainer. New endpoints are added deliberately, one line, reviewable.
6. **Docs + ADR:** template README/CLAUDE.md explain how sessions must be started, written
   host-agnostically (one path for desktop OSes, one for headless Linux — no Jarvis-specific
   paths or assumptions; Jarvis specifics stay in HQ's homelab docs); ADR 0016
   records the boundary decision (extends ADR 0013's "consequences" with honest defense-in-depth
   framing: hypervisor/container boundary + credential absence + scoped PAT + egress allowlist
   + human merge gate — no single layer is "100% safe"; together the blast radius is one branch).

## Out of scope

- Layering Claude Code's native (bubblewrap) sandbox inside the boundary
- Org-level managed-settings enforcement; multi-user concerns
- CI-side enforcement (verifying PRs originated from a sandbox)
- Auditing/replacing the contents of the host `~/.claude` mount for non-forge projects

## Acceptance criteria

1. Spike report committed (`docs/spikes/002-docker-sandboxes.md`) covering BOTH host classes:
   laptop/Docker Desktop and headless Linux over SSH+tmux — install, Claude Code run,
   workspace sync each marked working/broken per class, with an explicit go/no-go per class
   and the resulting boundary assignment (sandbox or devcontainer fallback) for each.
2. Guard hook ships in the plugin; demonstrated in all three states: blocked (host session in
   product repo), passing (inside boundary), override (loud). Evidence in the handoff.
3. Template ships `.forge.json`, sandbox setup docs (boundary setup, `sbx policy` starter
   allowlist, per-repo PAT creation guide), and `FORGE_SANDBOX=devcontainer` in the fallback
   devcontainer's `containerEnv`.
4. Fallback devcontainer hardened: egress allowlist (init-firewall adaptation), explicit
   "never mounted" list (no `~/.azure`, `~/.kube`, `~/.aws`, no cloud env vars), startup check
   that fails loudly if cloud credentials are detectable inside.
5. ADR 0016 committed; ADR 0013 cross-referenced.
6. `claude plugin validate . --strict` passes with the new hook.
