# Migrations runbook

## Model
- Migrations are ordered `migrations/*.sql` files, embedded into the binary and
  applied in lexicographic order (numeric prefixes).
- The `orchestrator_migrations` table records each applied file name and its
  `applied_at` (UTC RFC 3339). A file that is already recorded is skipped, so
  `Migrate` is idempotent and safe to call on every startup.
- Each file runs in its own transaction; a failure rolls back that file.

## Non-destructive diagnosis
Diagnosis must never mutate, delete, or "fix" the database to force a green
light.

1. **Confirm which files are applied:**
   ```sh
   sqlite3 "$ORCHESTRATOR_DB_PATH" \
     'SELECT filename, applied_at FROM orchestrator_migrations ORDER BY filename;'
   ```
2. **Re-run the migration runner** (idempotent). This is the only supported
   way to bring a partially-applied database forward:
   ```sh
   cd orchestrator && go run ./cmd/factory-orchestrator
   ```
   The service applies any missing files, then re-checks readiness.
3. **Read the failed file's SQL** to understand the constraint that tripped.
   The failing file is the one named in the service log.

## Backup precondition
Always copy the database directory (main file **and** the `-wal`/`-shm`
sidecars) before attempting to repair or roll back.

```sh
cp -a "$ORCHESTRATOR_DB_PATH" .backup/orch.db
cp -a "$ORCHESTRATOR_DB_PATH"-wal .backup/ 2>/dev/null || true
cp -a "$ORCHESTRATOR_DB_PATH"-shm .backup/ 2>/dev/null || true
```

## Rollback
- Migrations in Phase 0 are additive (new tables and indexes, `IF NOT EXISTS`).
  A new, unapplied file that fails has not written committed rows; re-running
  after fixing the cause re-attempts it.
- **Never** delete the database, drop the `orchestrator_migrations` record of an
  already-applied file, or hand-edit it to skip a failed file. If a file must
  be withdrawn, add a *new* later migration that supersedes it; do not edit or
  remove an already-applied one.

## What a failed migration means for readiness
A failed migration leaves the schema incomplete, so `/health/ready` stays
`503` on the `database` dependency. The service remains live. Recovery is:
backup → fix the SQL or the data it rejects → re-run the runner → readiness
turns `200` once the `database` probe passes again.
