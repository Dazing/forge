# factory-orchestrator (Phase 0 control-plane bootstrap)

Phase 0 owns **persistence and readiness only**: it opens the SQLite database,
applies the ordered migrations, and serves liveness/readiness. GitLab
mutations, scheduling, model calls, launch dispatch, patch publication, and
release execution are later-phase behavior and are intentionally absent.

## Layout

- `cmd/factory-orchestrator/` — composition root (`main.go`).
- `internal/config/` — typed configuration from the environment.
- `internal/store/` — SQLite open (WAL, FK, busy_timeout), migrations, probe.
- `internal/health/` — readiness `Checker` and the four dependency probes.
- `internal/httpserver/` — `GET /health/live` and `GET /health/ready`.
- `internal/{webhook,gitlab,projector,policy,scheduler,launcher,adapter,publisher,reconciler,reporter,release}/`
  — the eleven design §7.1 module boundaries (placeholders for Phase 0).
- `migrations/` — ordered `*.sql` migrations plus the embedded runner.

## Build and run

```sh
# From the repository root. The workspace (go.work) already uses ./orchestrator.
go build ./orchestrator/...

# Local startup (module is a Go workspace member):
cd orchestrator
go run ./cmd/factory-orchestrator
```

The process opens the SQLite file, runs migrations, then listens on
`ORCHESTRATOR_LISTEN_ADDR`. A migration failure is logged but does not crash
the process: it leaves the database non-migrated, so `/health/ready` stays
`503` until the migration succeeds.

## Required environment

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ORCHESTRATOR_DB_PATH` | yes | — | SQLite file path (created if missing). |
| `ORCHESTRATOR_GITLAB_BASE_URL` | yes | — | GitLab REST base URL for the reachability probe. |
| `ORCHESTRATOR_GITLAB_TOKEN_ENV` | yes | — | **Name** of the env var that holds the GitLab token value. The value is read at probe time, never logged or persisted. |
| `ORCHESTRATOR_PUBLISHER_SOCKET` | yes | — | Unix-socket path of the trusted publisher. |
| `ORCHESTRATOR_WORKER_HOST` | yes | — | Forced-command worker host (tailnet or internal VLAN). |

Optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORCHESTRATOR_BUSY_TIMEOUT_MS` | `5000` | Busy timeout (ms) for the SQLite write lock. |
| `ORCHESTRATOR_WORKER_PORT` | `22` | OpenSSH forced-command port on the worker. |
| `ORCHESTRATOR_LISTEN_ADDR` | `127.0.0.1:8443` | Address the health server binds. |

The GitLab token value itself is whatever the variable named by
`ORCHESTRATOR_GITLAB_TOKEN_ENV` resolves to (for example, if
`ORCHESTRATOR_GITLAB_TOKEN_ENV=ORCH_GITLAB_TOKEN`, the value comes from
`ORCH_GITLAB_TOKEN`).

## Health endpoints

- `GET /health/live` — `200` while the process can serve (liveness).
- `GET /health/ready` — `200` only when all four probes pass (migrated/writable
  SQLite, GitLab reachability with the current token, publisher socket, worker
  reachability); otherwise `503`. The body lists dependency names and bounded
  statuses only; no secret values are ever emitted.

Readiness has **no route that approves, merges, deploys, or mutates GitLab**.

## Diagnostics

See `runbooks/`:
- `runbooks/startup.md` — migration-before-readiness startup order.
- `runbooks/migrations.md` — non-destructive migration diagnosis and backup.
- `runbooks/readiness.md` — meaning of each health status.
