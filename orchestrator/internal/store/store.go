// Package store opens the Phase 0 SQLite database in WAL mode with foreign-key
// enforcement and a configured busy timeout, runs the ordered migrations, and
// exposes a read/write probe used by readiness.
//
// store is shared platform plumbing: it owns no workflow state and no
// feature-specific logic. Large payloads are not stored here; tables carry
// bounded artifact references.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"factory.local/platform/orchestrator/migrations"
)

// Store wraps the configured SQLite database.
type Store struct {
	db *sql.DB
}

// Open opens (or creates) the SQLite file at path in WAL mode with foreign
// keys enabled and the configured busy timeout. Every new connection is
// configured with those settings, so callers must not open additional
// connections against the same file with different settings. A single
// connection is kept to guarantee one writer and apply the DSN pragmas once.
func Open(ctx context.Context, path string, busyTimeout time.Duration) (*Store, error) {
	if path == "" {
		return nil, fmt.Errorf("store: empty database path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("store: create database directory: %w", err)
	}

	ms := int64(busyTimeout / time.Millisecond)
	if ms < 0 {
		ms = 0
	}
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", ms))
	dsn := path + "?" + q.Encode()

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("store: open: %w", err)
	}
	db.SetMaxOpenConns(1)

	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("store: open: %w", err)
	}
	return &Store{db: db}, nil
}

// Migrate applies every ordered migration that has not already been applied.
// Migration failure prevents the service from becoming ready.
func (s *Store) Migrate(ctx context.Context) error {
	return migrations.Run(ctx, s.db)
}

// DB returns the underlying *sql.DB. Exposed so callers (and tests) can
// run the store's own queries with its connection settings; the store's
// pragmas apply to this single-connection pool.
func (s *Store) DB() *sql.DB {
	return s.db
}

// HealthProbe verifies the database is migrated and writable: it confirms
// every embedded migration is recorded in orchestrator_migrations, then
// performs a read and an idempotent write on the main database file.
func (s *Store) HealthProbe(ctx context.Context) error {
	names, err := migrations.Names()
	if err != nil {
		return fmt.Errorf("store: list migrations: %w", err)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT filename FROM orchestrator_migrations`)
	if err != nil {
		return fmt.Errorf("store: migration probe: %w", err)
	}
	applied := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return fmt.Errorf("store: migration probe: %w", err)
		}
		applied[name] = true
	}
	rows.Close()
	for _, name := range names {
		if !applied[name] {
			return fmt.Errorf("store: migration %q not applied", name)
		}
	}
	var one int
	if err := s.db.QueryRowContext(ctx, `SELECT 1`).Scan(&one); err != nil {
		return fmt.Errorf("store: read probe: %w", err)
	}
	if _, err := s.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS orchestrator_health_probe (
            id        INTEGER PRIMARY KEY CHECK (id = 1),
            probed_at TEXT    NOT NULL
        )`); err != nil {
		return fmt.Errorf("store: write probe: %w", err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := s.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO orchestrator_health_probe (id, probed_at) VALUES (1, ?)`,
		now); err != nil {
		return fmt.Errorf("store: write probe: %w", err)
	}
	return nil
}

// Close releases the underlying database handle.
func (s *Store) Close() error {
	return s.db.Close()
}
