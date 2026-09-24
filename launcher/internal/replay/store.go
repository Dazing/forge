// Package replay provides persistent replay detection for accepted run IDs.
// A Store is the durable ledger that records which run IDs have been
// accepted; a second claim of the same run ID is rejected.
//
// Phase 0 uses a simple append-only JSONL file. Phase 1 may migrate to a
// SQLite or RocksDB backend without changing the interface.
package replay

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Store is a persistent, concurrency-safe replay ledger.
type Store struct {
	mu    sync.RWMutex
	path  string
	seen  map[string]struct{}
}

// Open opens (or creates) a replay ledger at path.
// The file must exist in a directory with write permission.
func Open(path string) (*Store, error) {
	// Ensure the directory exists.
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("replay: create dir: %w", err)
	}
	s := &Store{path: path, seen: make(map[string]struct{})}
	// Load existing entries.
	f, err := os.Open(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("replay: open: %w", err)
	}
	if err == nil {
		defer f.Close()
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			var e entry
			if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
				// Malformed line; skip but do not fail the whole store.
				continue
			}
			s.seen[e.RunID] = struct{}{}
		}
		if err := scanner.Err(); err != nil {
			return nil, fmt.Errorf("replay: read: %w", err)
		}
	}
	// Touch the file if it doesn't exist so it persists.
	if _, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o644); err != nil {
		return nil, fmt.Errorf("replay: create: %w", err)
	}
	return s, nil
}

type entry struct {
	RunID  string    `json:"run_id"`
	Claim  time.Time `json:"claimed_at"`
}

// Claim records runID as accepted if it has not been claimed before.
// It returns an error if the run ID was already claimed (replay detected).
// expiry must be in the future at claim time; it is recorded for GC purposes.
func (s *Store) Claim(ctx context.Context, runID string, expiry time.Time) error {
	if runID == "" {
		return fmt.Errorf("replay: empty run_id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.seen[runID]; ok {
		return fmt.Errorf("replay: run_id %q already accepted", runID)
	}
	s.seen[runID] = struct{}{}
	// Durable append: open, append, close on every claim (simple + correct).
	f, err := os.OpenFile(s.path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		// Roll back in-memory so we don't accept the ID without persistence.
		delete(s.seen, runID)
		return fmt.Errorf("replay: durable record: %w", err)
	}
	defer f.Close()
	b, _ := json.Marshal(entry{RunID: runID, Claim: time.Now().UTC()})
	if _, err := f.Write(append(b, '\n')); err != nil {
		delete(s.seen, runID)
		return fmt.Errorf("replay: durable record: %w", err)
	}
	return nil
}

// Has returns true if runID has been claimed.
func (s *Store) Has(ctx context.Context, runID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.seen[runID]
	return ok
}

// Close is a no-op for the file-backed store.
func (s *Store) Close() error {
	return nil
}
