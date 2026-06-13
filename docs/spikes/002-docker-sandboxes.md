# Spike 002 — Docker Sandboxes as the forge boundary

**For:** brief 002 (sandbox enforcement), acceptance criterion #1 · **Status:**
methodology + harness ready; **results PENDING OPERATOR RUN** on real host classes.

## Question (go/no-go)

Can **Docker Sandboxes** (GA Jan 2026 — microVM isolation, host-side credential
proxy, built-in egress policy) be the primary forge boundary — running Claude Code
inside, with the workspace synced back to the host's repo checkout — **on each host
class** the framework must support?

Decision is **per host class**. Any class that fails uses the hardened fallback
devcontainer (`template/.devcontainer/`). The guard hook accepts either boundary, so a
**mixed fleet is a supported outcome, not a compromise.**

### Host classes

- **Class L — Desktop OS:** a laptop (macOS / Windows / Linux) with Docker Desktop.
  This is the documented-and-expected case.
- **Class H — Headless Linux:** a server with a standalone Linux/KVM Docker install,
  driven over **SSH + tmux**, no GUI. This is the unconfirmed case.

## Decision rule (state before running, to avoid post-hoc rationalising)

For a class to be **GO** (→ Docker Sandboxes), all three must be `working`:

1. **Install** — `sbx` CLI installs and authenticates on that host class.
2. **Claude Code run** — Claude Code launches and operates *inside* the sandbox
   (microVM), reaching only the allowlisted egress.
3. **Workspace sync** — edits made inside the sandbox land in the host's repo
   checkout (and host edits are visible inside), reliably and without manual copying.

Any of the three `broken` (or blocked with no reasonable workaround) → **NO-GO** for
that class → assign the **hardened fallback devcontainer**.

## Procedure (run per host class, record verbatim evidence)

> Record the exact commands and their output. "Working" means observed, not assumed.

### Step 1 — Install `sbx`
- Class L: install via Docker Desktop's bundled Sandboxes, or the standalone CLI.
- Class H: standalone CLI install over SSH; confirm it runs headless.
- Capture: `sbx --version`, auth/login result, any subscription/licensing prompt.

### Step 2 — Egress policy
- `sbx policy set locked-down` then add the forge starter allowlist
  (api.anthropic.com, statsig.anthropic.com, sentry.io, registry.npmjs.org,
  api.nuget.org, github.com + api/codeload/objects.githubusercontent.com).
- Capture: policy listing; one allowed fetch succeeds, one denied fetch fails.

### Step 3 — Run Claude Code inside
- Launch a sandbox over this repo's checkout; start Claude Code inside it.
- Confirm `FORGE_SANDBOX=docker-sandbox` is set inside and the guard hook passes.
- Capture: `env | grep FORGE_SANDBOX`, a trivial agent action, egress behaviour.

### Step 4 — Workspace sync
- Inside the sandbox: create/modify a file; outside (host): `git status` shows it.
- On the host: modify a file; inside: the change is visible.
- Capture: both directions, and note latency / any manual step required.

### Step 5 — Credentials (smoke)
- Provision the scoped GitHub PAT via the boundary's secret/proxy mechanism; confirm
  it is usable for `git push` from inside **without** the token materialising in the VM
  (e.g. it does not appear in `env` or on disk inside the sandbox).

## Results

| Host class | Install | Claude run | Workspace sync | Creds (smoke) | Verdict | Boundary assigned |
|---|---|---|---|---|---|---|
| **L — Desktop OS** | ⏳ pending | ⏳ pending | ⏳ pending | ⏳ pending | **pending** | _tbd_ |
| **H — Headless Linux** | ⏳ pending | ⏳ pending | ⏳ pending | ⏳ pending | **pending** | _tbd_ |

> Fill each cell `working` / `broken` / `n/a` with a one-line evidence pointer, then
> set the verdict (GO/NO-GO) and the assigned boundary per the decision rule above.

### Environment notes from the planning box (2026-06-13)

Recorded so the operator knows the starting state on at least one Class H candidate
(this is **not** a result — no `sbx` run was performed):

- Host: headless Linux (`Linux ArcLegion 6.17.0-35-generic`, Ubuntu 24.04, x86_64).
- Docker: **29.5.3** present and working.
- `sbx` CLI: **not installed.** Docker Sandboxes requires its CLI + a paid
  subscription/auth; neither was provisioned during planning, so the Class H run is
  left to the operator. This box is a valid Class H candidate to run Step 1–5 on.

## Outcome → what it drives

- Per-class verdict sets `FORGE_SANDBOX` value used (`docker-sandbox` vs
  `devcontainer`) for that class — the guard hook treats both as approved.
- A NO-GO class falls back to `template/.devcontainer/` (already hardened: egress
  allowlist, no-cloud-creds check, no cloud mounts).
- Record the final assignment here and reflect any deviation in `SANDBOX.md`.
