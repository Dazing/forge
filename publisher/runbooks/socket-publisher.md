# Unix-socket publisher runbook

## Purpose

`factory-publisher` runs under a separate OS user on the control VM. It
binds only a Unix socket (no TCP) and accepts `PublishRequest` frames from
the orchestrator over that socket. It validates all fields, re-clones the
expected base SHA, applies the patch with no fuzz, rejects unsafe content,
and commits/pushes only the deterministic `factory/*` branch.

## Socket

The socket is created by `factory-publisher` and removed on exit.
Permissions are `0600` — only the publisher OS user (and root) may connect.

The orchestrator writes patch archives to a root-owned temporary directory
before sending the `PublishRequest`. The publisher reads the archive; the
orchestrator never reads the publisher's Git credential.

## Request/response framing

One JSON object per direction, not newline-delimited (JSON has no
structural end-of-frame marker; the connection closes after each exchange).

**Request** (`PublishRequest`):

```json
{
  "project_id": 101,
  "issue_iid": 42,
  "base_sha": "0123456789abcdef0123456789abcdef01234567",
  "patch_path": "/run/factory/patches/pk-1.bundle",
  "branch": "factory/p-101-i-42",
  "patch_sha256": "<sha256-of-archive>",
  "idempotency_key": "pk-1"
}
```

**Response** (`PublishResult`):

```json
{ "branch": "factory/p-101-i-42", "head_sha": "deadbeef", "is_noop": false }
```

On rejection:

```json
{ "branch": "", "is_noop": false, "error": "branch \"main\" is not the factory branch \"factory/p-101-i-42\"" }
```

## Validation pipeline

| step | check | rejection |
|------|-------|-----------|
| 1    | branch == `factory/p-{project_id}-i-{issue_iid}` | `branch … is not the factory branch` |
| 2    | re-clone at `base_sha` succeeds | `re-clone base: …` |
| 3    | patch applies with no fuzz | `apply patch: …` |
| 4    | no gitlink entries (submodules) | `submodule in patch: …` |
| 5    | no symlinks resolving outside repo root | `escaping symlink in patch: …` |
| 6    | no PEM keys, API key prefixes, or other credential markers | `credential marker in patch: …` |
| 7    | commit + push to factory branch | `commit: …` / `push to …` |

## Security invariants

- No TCP listener.
- No arbitrary ref; only `factory/*` is accepted.
- No force-push; an unexpected head blocks the request.
- No source-branch write path.
- The publisher Git credential is readable only by the publisher OS user.
- Signing material and patch content are never logged.

## Phase 0 scope

Phase 0 uses a no-op `GitClient`; the real Git operations (clone, apply,
commit, push under the publisher credential) land in Phase 3 behind the
same `publish.GitClient` interface. The validation pipeline and branch
policy are fully implemented and tested in Phase 0.
