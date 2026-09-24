# Startup runbook

## Goal
Bring `factory-orchestrator` to a state where `/health/ready` can return `200`,
without losing data or bypassing a failed migration.

## Precondition: backup
The SQLite database file is the single source of truth for Phase 0 state.
Before any operator intervention that touches it:

```sh
# Copy the whole directory (WAL + SHM sidecar files matter).
cp -a "$ORCHESTRATOR_DB_PATH".{db,shm,wal} .backup/ 2>/dev/null || true
cp -a "$ORCHESTRATOR_DB_PATH" .backup/
```

Back up the WAL (`-wal`) and shared-memory (`-shm`) sidecars, not just the main
file. A WAL-mode database that has been cleanly shut down folds its WAL back
into the main file; a running one needs the sidecars.

## Order of operations
1. Confirm configuration is present (see `README.md` required variables). The
   service fails fast at startup if a required variable is missing.
2. Start the service: `go run ./cmd/factory-orchestrator`.
3. Migrations run before the readiness gate. The service:
   - opens the SQLite file in WAL mode with foreign keys and the configured
     busy timeout,
   - applies every unapplied `migrations/*.sql` file in lexicographic order,
   - then starts serving.
4. Poll readiness until it turns `200`:

   ```sh
   curl -fsS http://$ORCHESTRATOR_LISTEN_ADDR/health/ready | jq .
   ```

## Liveness vs readiness
- `GET /health/live` returns `200` as soon as the process can serve. A live
  service can still be not-ready.
- `GET /health/ready` returns `503` while any required probe is down. The body
  lists each dependency's name and bounded status.

## Failure handling
- **Migration failure** is logged, not fatal to the process. Readiness stays
  `503`. Do not bypass the migration; see `runbooks/migrations.md`.
- **A probe down** (GitLab, publisher socket, worker) leaves readiness at
  `503` but does not affect liveness. Fix the underlying dependency.

Never delete the SQLite database to recover; restore from the last backup and
re-run migrations (see `runbooks/migrations.md`).
