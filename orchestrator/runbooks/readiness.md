# Readiness runbook

## Endpoints
- `GET /health/live` — liveness. `200` while the process can serve.
- `GET /health/ready` — readiness. `200` only when **all four** required
  probes pass; otherwise `503`. The body is JSON:

  ```json
  {
    "ready": false,
    "dependencies": [
      {"Dependency": "database",  "Ready": true,  "Status": "ok"},
      {"Dependency": "gitlab",    "Ready": false, "Status": "unavailable"},
      {"Dependency": "publisher", "Ready": true,  "Status": "ok"},
      {"Dependency": "worker",    "Ready": true,  "Status": "ok"}
    ]
  }
  ```

  Status is a bounded token: `ok` or `unavailable`. **No secret value, probe
  error text, or environment content is ever emitted** — only the dependency
  name and the bounded status.

## Meaning of each health status
- `live = 200` — the event loop and HTTP handler are up. This says nothing
  about dependencies.
- `ready = 200` — every required probe passed on this cycle:
  - **database**: the SQLite file opened in WAL/FK mode, all migrations are
    applied, and a read+write probe succeeded.
  - **gitlab**: GitLab was reachable with the current token (token read from
    its named environment variable at probe time).
  - **publisher**: the trusted publisher Unix socket accepted a connection.
  - **worker**: the forced-command worker host:port accepted a TCP connection.
- `ready = 503` — at least one probe failed; the `dependencies` array names
  which.

## Non-destructive diagnosis
Diagnosis is read-only and must not mutate GitLab, delete the database, or
bypass a failed migration.

1. **Poll and read the per-dependency result:**
   ```sh
   curl -s http://$ORCHESTRATOR_LISTEN_ADDR/health/ready | jq -r '.dependencies[] | "\(.Dependency)=\(.Status)"'
   ```
2. **Act on the failing dependency:**
   - `database` → `runbooks/migrations.md` (backup first). Never delete the DB.
   - `gitlab` → check `ORCHESTRATOR_GITLAB_BASE_URL` reachability and that the
     token env var (named by `ORCHESTRATOR_GITLAB_TOKEN_ENV`) is set and valid.
     The token value itself is never printed; verify its presence, not its text.
   - `publisher` → confirm the publisher process is up and its Unix socket path
     matches `ORCHESTRATOR_PUBLISHER_SOCKET`.
   - `worker` → confirm the worker host/port (`ORCHESTRATOR_WORKER_HOST` /
     `ORCHESTRATOR_WORKER_PORT`) accepts the forced-command connection.
3. **Re-poll until `ready` turns `200`.** Each probe runs on every request;
   no state is mutated by checking.

## Invariants
- Readiness checking triggers **no** workflow, GitLab, or release mutation.
- A not-ready service is still live; readiness recovers automatically once the
  failing probe's dependency is restored. No restart is required for
  dependency-level recovery.
