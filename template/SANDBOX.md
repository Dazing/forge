# Sandbox — how to start a session on this repo

This repo declares **`.forge.json` → `"sandbox": "required"`**. Per forge
[ADR 0013](https://github.com/dazing/forge/blob/main/docs/adr/0013-autonomy-free-until-merge-sandboxed.md)
and [ADR 0016](https://github.com/dazing/forge/blob/main/docs/adr/0016-sandbox-boundary-docker-sandboxes.md),
a forge session here runs inside a **credential-free boundary**: the agent gets the
repo, the local toolchain, and a scoped GitHub token — and nothing else (no cloud
CLIs, no kubeconfigs, no service-account keys). The forge plugin's `SessionStart`
guard hook checks for this and warns loudly if you start a session on the bare host.

> **Safety is defense in depth, not a single guarantee.** Boundary isolation +
> credential absence + a one-repo scoped PAT + an egress allowlist + the human-only
> merge gate. No single layer is "100% safe"; together, the worst-case blast radius
> of a rogue or prompt-injected session is **one repo's feature branches** — `main`
> is protected by the merge gate.

Every approved boundary exports **`FORGE_SANDBOX=<docker-sandbox|devcontainer>`**,
which is how the guard hook knows you're inside one.

---

## Pick your boundary by host class

Two host classes, two documented paths. Which boundary each class uses is decided by
the spike
([`docs/spikes/002-docker-sandboxes.md`](https://github.com/dazing/forge/blob/main/docs/spikes/002-docker-sandboxes.md)
in the forge repo) — a mixed fleet (Docker Sandboxes on one class, devcontainer on
another) is fully supported.

| Host class | Example | Primary boundary | Fallback |
|---|---|---|---|
| **Desktop OS** | macOS / Windows / Linux laptop with Docker Desktop | Docker Sandboxes | hardened devcontainer |
| **Headless Linux** | a server driven over SSH + tmux | Docker Sandboxes *(if the spike says go)* | hardened devcontainer |

### Path A — Docker Sandboxes (primary)

Docker Sandboxes (GA Jan 2026) gives microVM isolation, a host-side credential proxy
(secrets never enter the VM), and built-in deny-by-default egress.

```bash
# 1. Install the Docker Sandboxes CLI (`sbx`) — see Docker's docs for your host.
#    Desktop OS: bundled with recent Docker Desktop.
#    Headless Linux: standalone install, driven over SSH.

# 2. Set the egress policy for this repo (see "Egress allowlist" below).
sbx policy set locked-down            # deny-all baseline
#    ...then add the forge starter allowlist (one entry per line, reviewable).

# 3. Provision the scoped GitHub PAT into the boundary's secret store
#    (see "GitHub credentials" below) — the token never materialises in the VM.

# 4. Launch Claude Code inside the sandbox, with the workspace synced to this checkout.
#    The boundary sets FORGE_SANDBOX=docker-sandbox; the guard hook then passes silently.
```

### Path B — Hardened fallback devcontainer

Used wherever the spike marks Docker Sandboxes **no-go**. The hardened devcontainer
ships in [`.devcontainer/`](./.devcontainer/) and already:

- sets `FORGE_SANDBOX=devcontainer` (`containerEnv`) so the guard hook passes;
- installs a **deny-by-default egress allowlist** on every start
  ([`init-firewall.sh`](./.devcontainer/init-firewall.sh));
- runs a **cloud-credential check that fails loudly** if any cloud cred is detectable
  ([`verify-no-cloud-creds.sh`](./.devcontainer/verify-no-cloud-creds.sh));
- mounts **no** cloud config and passes in **no** cloud env vars (see the "NEVER
  MOUNTED" list in `devcontainer.json`).

```bash
# Desktop OS: "Reopen in Container" (VS Code) or `devcontainer up`.
# Headless Linux: `devcontainer up --workspace-folder .` then `devcontainer exec ... claude`.
# Export GH_TOKEN in the HOST shell first (see "GitHub credentials").
```

---

## Egress allowlist (`sbx policy` / firewall)

Default policy is **Locked Down** (deny-all) plus this forge **starter allowlist**.
New endpoints are added deliberately — one line, in review.

```
# Anthropic API + telemetry
api.anthropic.com
statsig.anthropic.com
sentry.io
# Package registries
registry.npmjs.org
api.nuget.org
# GitHub
github.com
api.github.com
codeload.github.com
objects.githubusercontent.com
```

- **Docker Sandboxes:** encode this in `sbx policy` (Path A).
- **Devcontainer:** the same list lives in
  [`.devcontainer/init-firewall.sh`](./.devcontainer/init-firewall.sh) as the
  `ALLOWED_DOMAINS` array (plus GitHub's published CIDR ranges via `api.github.com/meta`).

---

## GitHub credentials (per-repo scoped PAT)

The boundary's only credential is a **fine-grained personal access token scoped to
this one repo**. Blast radius of a leak: this repo's branches/PRs only — `main` is
protected by the merge gate.

Create it once:

1. GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new**.
2. **Resource owner:** the org/user that owns this repo. **Repository access:** *Only
   select repositories* → **this repo only**.
3. **Permissions:** `Contents` = Read and write · `Pull requests` = Read and write.
   **Nothing else.**
4. **Expiration:** 90 days. (Rotate on expiry.)

Deliver it to the boundary:

- **Docker Sandboxes:** add it to the boundary's secret/proxy store so it never
  materialises in the VM.
- **Devcontainer:** export it in your **host** shell before launch; the container
  picks it up via `remoteEnv.GH_TOKEN`. Keep it out of the repo — use a git-ignored
  file (e.g. `.devcontainer/secrets.env`, already git-ignored) sourced by your shell,
  never a committed file.

---

## Override (loud, discouraged)

The single sanctioned bypass is:

```bash
FORGE_SANDBOX_OVERRIDE=1   # set in the environment before starting Claude Code
```

This lets a session start on the bare host, but the guard hook announces it loudly in
the transcript and the agent is told to treat the host as credential-bearing. Use it
only when you know exactly why.
