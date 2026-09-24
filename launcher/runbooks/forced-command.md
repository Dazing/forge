# forced-command launcher runbook

## Purpose

`factory-launcher` is the OpenSSH forced command on the factory worker VM.
It accepts only signed canonical run specifications and exposes no shell,
PTY, or arbitrary command protocol to the SSH client.

## authorized_keys entry

```
command="/usr/bin/factory-launcher -ledger /var/factory/replay.jsonl -pubkey /etc/factory/launcher-pub.pem" no-pty,no-port-forwarding,no-agent-forwarding ssh-ed25519 <pubkey>
```

- `no-pty` — no PTY allocation.
- `no-port-forwarding` — no local/remote/socks forwarding.
- `no-agent-forwarding` — no SSH agent forwarding.
- The `command=` directive replaces the shell entirely; the client's
  `Command=` request is ignored.

## Request/response framing

One JSON object per direction, newline-delimited.

**Request** (stdin):

```json
{
  "op": "create",
  "env": {
    "spec_json": "<base64 canonical RunSpec JSON>",
    "signature": "<base64 Ed25519 signature>"
  }
}
```

**Response** (stdout):

```json
{ "op": "create", "result": { "op": "create", "run_id": "run-001", "state": "running" } }
```

On failure:

```json
{ "op": "create", "error": "runspec: invalid Ed25519 signature" }
```

## Operations

| op      | accepted |
|---------|----------|
| create  | yes      |
| status  | yes      |
| cancel  | yes      |
| destroy | yes      |
| other   | rejected with `unsupported op` |

## Security invariants

- The launcher verifies the Ed25519 signature before any state mutation.
- `run_id` is claimed durably before lifecycle dispatch; replay is rejected.
- Digest-only image references: mutable tags are rejected at the
  `runspec.Verify` boundary.
- No shell, PTY, port forwarding, or agent forwarding is possible.
- Signing material and workspace credential content are never logged.

## Replay ledger

`/var/factory/replay.jsonl` is an append-only JSONL file. One line per
accepted run ID. The launcher reads it on startup and appends on every
successful claim.

## Phase 0 scope

Phase 0 returns a `state` placeholder per operation. Real Docker lifecycle
(container create, network attach, sidecar start, destroy, GC) lands in
Phase 3 behind the same `server.Handle` boundary.
