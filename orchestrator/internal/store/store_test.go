package store_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"factory.local/platform/orchestrator/internal/store"
)

func openMigrated(t *testing.T, path string) *store.Store {
	t.Helper()
	st, err := store.Open(context.Background(), path, 5*time.Second)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return st
}

func TestOpenAppliesWALForeignKeysAndBusyTimeout(t *testing.T) {
	st := openMigrated(t, filepath.Join(t.TempDir(), "orch.db"))
	ctx := context.Background()
	db := st.DB()

	var jm string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&jm); err != nil {
		t.Fatalf("journal_mode: %v", err)
	}
	if jm != "wal" {
		t.Fatalf("journal_mode = %q, want wal", jm)
	}

	var fk int
	if err := db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk); err != nil {
		t.Fatalf("foreign_keys: %v", err)
	}
	if fk != 1 {
		t.Fatalf("foreign_keys = %d, want 1", fk)
	}

	var bt int
	if err := db.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&bt); err != nil {
		t.Fatalf("busy_timeout: %v", err)
	}
	if bt != 5000 {
		t.Fatalf("busy_timeout = %d, want 5000", bt)
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	st := openMigrated(t, filepath.Join(t.TempDir(), "orch.db"))
	// Second run must be a no-op and still succeed.
	if err := st.Migrate(context.Background()); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
}

func TestAllExpectedTablesExist(t *testing.T) {
	st := openMigrated(t, filepath.Join(t.TempDir(), "orch.db"))
	want := []string{
		"webhook_delivery", "project", "work_item", "dependency", "plan",
		"run", "merge_request", "review", "lease", "transition", "action",
		"release_candidate",
	}
	db := st.DB()
	for _, table := range want {
		var n int
		err := db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&n)
		if err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if n != 1 {
			t.Fatalf("table %q present %d times, want 1", table, n)
		}
	}
}

func TestMigrationsTableRecordsAppliedFile(t *testing.T) {
	st := openMigrated(t, filepath.Join(t.TempDir(), "orch.db"))
	var name string
	if err := st.DB().QueryRow("SELECT filename FROM orchestrator_migrations WHERE filename='001_initial.sql'").Scan(&name); err != nil {
		t.Fatalf("migration record: %v", err)
	}
	if name != "001_initial.sql" {
		t.Fatalf("recorded migration = %q, want 001_initial.sql", name)
	}
}

func TestForeignKeyViolationRejected(t *testing.T) {
	st := openMigrated(t, filepath.Join(t.TempDir(), "orch.db"))
	// work_item references project(gitlab_id); with FK enforcement ON, an
	// orphan row must fail.
	_, err := st.DB().Exec("INSERT INTO work_item (project_id, issue_iid, created_at, updated_at) VALUES (999999, 1, '2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z')")
	if err == nil {
		t.Fatalf("FK-violating work_item insert succeeded, want error")
	}
}

func TestUniqueKeyEnforced(t *testing.T) {
	st := openMigrated(t, filepath.Join(t.TempDir(), "orch.db"))
	db := st.DB()
	if _, err := db.Exec("INSERT INTO project (gitlab_id, path, created_at, updated_at) VALUES (1, 'group/proj', '2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z')"); err != nil {
		t.Fatalf("first project insert: %v", err)
	}
	// action PK is idempotency_key; a duplicate must fail.
	if _, err := db.Exec("INSERT INTO action (idempotency_key, action_type, target, request_hash, state, created_at, updated_at) VALUES ('k1', 'deploy', 't', 'h', 'pending', '2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z')"); err != nil {
		t.Fatalf("first action insert: %v", err)
	}
	if _, err := db.Exec("INSERT INTO action (idempotency_key, action_type, target, request_hash, state, created_at, updated_at) VALUES ('k1', 'deploy', 't', 'h', 'pending', '2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z')"); err == nil {
		t.Fatalf("duplicate action idempotency_key insert succeeded, want UNIQUE failure")
	}
}

func TestHealthProbeReadWrite(t *testing.T) {
	st := openMigrated(t, filepath.Join(t.TempDir(), "orch.db"))
	if err := st.HealthProbe(context.Background()); err != nil {
		t.Fatalf("HealthProbe: %v", err)
	}
	// Idempotent.
	if err := st.HealthProbe(context.Background()); err != nil {
		t.Fatalf("second HealthProbe: %v", err)
	}
}

func TestHealthProbeFailsOnNonMigratedDB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "orch.db")
	st, err := store.Open(context.Background(), path, 5*time.Second)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	// Do NOT call Migrate: the DB is non-migrated.
	if err := st.HealthProbe(context.Background()); err == nil {
		t.Fatal("HealthProbe on non-migrated DB: want error, got nil")
	}
	// After migration, the probe succeeds.
	if err := st.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if err := st.HealthProbe(context.Background()); err != nil {
		t.Fatalf("HealthProbe after Migrate: %v", err)
	}
}
