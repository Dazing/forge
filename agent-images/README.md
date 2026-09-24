# agent-images

Pinned, scanned agent/runtime image build pipeline. Produces one
digest-pinned `node-dotnet-playwright` execution image from immutable
lock-backed inputs, scans the resolved digest, and publishes **only the
resolved `image@sha256:` reference** for later execution. Tags are
human-readable metadata only — every consumer uses `image@sha256:`.

The combined image derives from the locked `.NET Playwright` base and adds a
checksum-verified Node 22 LTS archive, so the .NET and Node runtimes share
the Playwright browser dependencies in one image.

## Inputs (locked)

Every external build and scan input is recorded in
[`images.lock`](./images.lock) as `{ name, reference_or_url, sha256,
platform }`:

| Entry | What it pins | Value |
|---|---|---|
| `playwright_dotnet_base` | MCR base image, resolved from tag `v1.62.0-noble` to a committed manifest-list digest; .NET SDK 10.0.302 + Playwright browsers | `mcr.microsoft.com/playwright/dotnet@sha256:25e558a8…ac1bb5` |
| `node_archive` | Node 22 LTS (`v22.23.2`, arm64) archive URL + official SHA-256 | `https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.xz` / `fff4078c…` |
| `trivy` | Scanner image (`aquasec/trivy:0.70.0`) pulled by digest; version `0.70.0` | `docker.io/aquasec/trivy@sha256:06c0a135…d91ab` |
| `platform` | Target platform (matches the workstation) | `linux/arm64` |

The lock is the authority. The Dockerfile and every script read exact locked
values through [`scripts/verify-lock`](./scripts/verify-lock) and
[`scripts/lock-get`](./scripts/lock-get), which reject missing, placeholder,
`latest`, or tag-only image input. Subsequent builds must not resolve mutable
tags; the digests are committed once and reused.

## Files

| File | Purpose |
|---|---|
| `images.lock` | Locked, immutable input values (digests, checksums, platform). |
| `Dockerfile` | Builds the combined image from the locked base + verified Node archive; records provenance labels; smoke-verifies executables in the final layer. |
| `scripts/verify-lock` | Single source of truth for lock completeness and immutability. |
| `scripts/lock-get` | Reads one locked value without re-parsing JSON; fails on a bad lock. |
| `scripts/build-image` | Build + push a temporary commit tag, resolve the pushed digest, write a `pending_scan` approval record. Never returns the tag as the approved value. |
| `scripts/scan-image` | Scan the resolved digest with the locked Trivy image (`vuln,secret` + image-config findings, JSON report, HIGH/CRITICAL block policy); finalize the record. |
| `scripts/validate-approval` | Validate a finalized approval record against the schema (stdlib only). |
| `scripts/smoke-runtime` | Runnable-anywhere lock + consistency + immutability check; prints the resolved `image@sha256:` reference. |
| `schemas/agent-image-approval.schema.json` | JSON Schema for the approval record. |
| `.gitlab-ci.yml` | The pipeline: verify → build → scan → publish. |

## Approval record

Machine-readable evidence written to `artifacts/agent-image-approval.json`,
validated against [`schemas/agent-image-approval.schema.json`](./schemas/agent-image-approval.schema.json):

```json
{
  "schema": "agent-images/schemas/agent-image-approval.schema.json",
  "source_commit": "a1b2c3d4…",
  "platform": "linux/arm64",
  "input_lock_sha256": "…",
  "image": "registry.example.com/…/node-dotnet-playwright@sha256:…",
  "scanner_image": "docker.io/aquasec/trivy@sha256:…",
  "scanner_version": "0.70.0",
  "report": "artifacts/trivy-report.json",
  "status": "approved"
}
```

`status` is `pending_scan` (built, not scanned), `approved` (scan passed;
digest publishable), or `blocked` (scan policy failed; publication blocked).
The `image` field MUST be a digest reference — the schema rejects tag-only
values.

## Local verification

```sh
./agent-images/scripts/smoke-runtime --lock agent-images/images.lock
```

Proves the lock is complete and immutable, the Dockerfile is consistent with
the lock, each locked input is currently immutable against upstream (live MCR
base digest + official Node `SHASUMS256.txt`), and prints the resolved
`image@sha256:` reference. Exit `0` with the `image@sha256:` reference in
output is success.

Registry push and the Trivy database-backed scan require protected
CI registry/scanner access and are exercised by `.gitlab-ci.yml`, not here.

## Pipeline

`verify-lock` → `build-image` → `scan-image` → `publish` (see
[`.gitlab-ci.yml`](./.gitlab-ci.yml)). Scanner database refresh is an explicit
CI input (`REFRESH_DB`), never a hidden unpinned image mutation. No registry
or scanner credentials are copied into the final runtime layer.
