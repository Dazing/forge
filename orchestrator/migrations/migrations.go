// Package migrations embeds the Phase 0 SQL migrations and applies them in
// order. Each migration runs exactly once and is recorded in a schema-table
// so a restart never re-runs it. Failure here prevents the service from
// becoming ready.
package migrations

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed *.sql
var files embed.FS

const applyTable = `
CREATE TABLE IF NOT EXISTS orchestrator_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);`

// Run applies every embedded .sql file that has not already been applied, in
// lexicographic (i.e. numeric-prefix) order. Each file runs in its own
// transaction.
func Run(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, applyTable); err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	names, err := listSQL()
	if err != nil {
		return err
	}

	applied, err := appliedNames(ctx, db)
	if err != nil {
		return err
	}

	for _, name := range names {
		if applied[name] {
			continue
		}
		data, err := files.ReadFile(name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, string(data)); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
		now, err := currentUTC(ctx, tx)
		if err != nil {
			tx.Rollback()
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO orchestrator_migrations (filename, applied_at) VALUES (?, ?)`,
			name, now); err != nil {
			tx.Rollback()
			return fmt.Errorf("record migration %s: %w", name, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}
	}
	return nil
}

// Names returns the ordered embedded .sql migration filenames.
func Names() ([]string, error) {
	return listSQL()
}

func listSQL() ([]string, error) {
	ents, err := files.ReadDir(".")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range ents {
		if e.Type().IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names, nil
}

func appliedNames(ctx context.Context, db *sql.DB) (map[string]bool, error) {
	rows, err := db.QueryContext(ctx, `SELECT filename FROM orchestrator_migrations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out[name] = true
	}
	return out, rows.Err()
}

// currentUTC returns the current time as a UTC RFC 3339 string.
func currentUTC(ctx context.Context, db *sql.Tx) (string, error) {
	var s string
	err := db.QueryRowContext(ctx, `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`).Scan(&s)
	return s, err
}
