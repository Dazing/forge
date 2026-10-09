# Vertical Slice Architecture — Go jobs dialect (CLI worker host)

Specializes `core.md` for the worker host (`cmd/worker`). Job slices follow the
**same VSA rules as HTTP slices** — only the trigger differs: a CLI invocation
and a run loop instead of an HTTP route.

## Noun mapping

| Backbone concept | Jobs form |
|---|---|
| Slice trigger (binding) | `cmd/worker/main.go` selects the job from `os.Args[1]` and calls its `Run` |
| Slice handler (glue) | A `Run(ctx context.Context, db *sql.DB) error` function |
| Extracted logic | Pure functions in the feature package (testable without the host) |
| Feature-owned data | `*sql.DB` injected into `Run` |
| Composition root | `cmd/worker/main.go` — arg parsing, DB init, job dispatch |
| Shared | `internal/db/`, cross-cutting clients injected via constructor |

## Folder shape

```
cmd/worker/
├── main.go                         ← composition root: parses arg, wires DB, dispatches job
└── jobs.go                         ← registry: maps job names to Run functions

internal/
├── features/
│   ├── sync_listings/
│   │   ├── sync_listings.go        ← types + Run(ctx, db) + schedule loop
│   │   ├── listing_logic.go        ← pure decision/calculation functions (IsDue, …)
│   │   └── sync_listings_test.go   ← behavioral tests colocated
│   └── send_digests/
│       ├── send_digests.go
│       └── send_digests_test.go
├── db/
│   ├── db.go                       ← *sql.DB creation, pool config
│   └── migrations/
└── middleware/                      ← not typically used in workers, but available
```

## Rules

- **Every job is a feature package** with a public `Run(ctx context.Context, db *sql.DB) error` function — the worker's entry point.
- **One job per binary** — the host selects the job from `os.Args[1]`; each job is its own deployment for failure isolation.
- **A job owns its schedule** — typically a `time.Ticker` loop inside `Run`. Catch per-run errors so one bad run doesn't crash the process.
- **No global state** — `*sql.DB` is passed in; the job opens no hidden connection pool.
- **Job handlers stay thin** — query → delegate to pure logic → persist.
  Extract business logic to pure functions exactly as on the HTTP side, so it's
  unit-testable without the host.

```go
// internal/features/sync_listings/sync_listings.go
package sync_listings

import (
    "context"
    "database/sql"
    "log/slog"
    "time"
)

func Run(ctx context.Context, db *sql.DB, interval time.Duration) error {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if err := runOnce(ctx, db); err != nil {
                slog.Error("sync run failed", "error", err)
                // do not return — keep the loop alive
            }
        }
    }
}

func runOnce(ctx context.Context, db *sql.DB) error {
    due, err := selectDueListings(ctx, db) // query helper in this package
    if err != nil {
        return fmt.Errorf("querying due listings: %w", err)
    }

    var toSync []Listing
    for _, l := range due {
        if IsDue(l, syncInterval) {
            toSync = append(toSync, l)
        }
    }

    if len(toSync) == 0 {
        return nil
    }

    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback()

    for _, l := range toSync {
        if err := updateSyncedAt(ctx, tx, l.ID, time.Now()); err != nil {
            return fmt.Errorf("updating listing %d: %w", l.ID, err)
        }
    }
    return tx.Commit()
}
```

```go
// cmd/worker/main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "time"

    "example.com/app/internal/db"
    "example.com/app/internal/features/sync_listings"
    "example.com/app/internal/features/send_digests"
)

func main() {
    if len(os.Args) < 2 {
        slog.Error("usage: worker <job-name>")
        os.Exit(1)
    }
    jobName := os.Args[1]

    database, err := db.Open(os.Getenv("DATABASE_URL"))
    if err != nil {
        slog.Error("opening database", "error", err)
        os.Exit(1)
    }
    defer database.Close()

    ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
    defer cancel()

    var runErr error
    switch jobName {
    case "sync-listings":
        runErr = sync_listings.Run(ctx, database, 15*time.Minute)
    case "send-digests":
        runErr = send_digests.Run(ctx, database, 1*time.Hour)
    default:
        slog.Error("unknown job", "name", jobName)
        os.Exit(1)
    }

    if runErr != nil && runErr != context.Canceled {
        slog.Error("job exited with error", "error", runErr)
        os.Exit(1)
    }
}
```

## TDD walkthrough (jobs)

The schedule loop is host plumbing; the **decision/calculation logic and
per-run orchestration are the testable units**. Extract logic so it's pure,
then unit-test with no host, no timer, no database. Test the per-run function
(`runOnce`) against a fixture-owned SQLite for data-access integration (see
`core.md` §TDD; cycle in the `tdd` skill).

```go
// internal/features/sync_listings/sync_listings_test.go — RED first

// Unit: extracted logic, plain data.
func TestIsDue_ReturnsTrue_WhenLastSyncedBeyondInterval(t *testing.T) {
    l := Listing{LastSyncedAt: time.Now().Add(-2 * time.Hour)}
    if !IsDue(l, time.Hour) {
        t.Error("expected true when last synced 2h ago with 1h interval")
    }
}

func TestIsDue_ReturnsFalse_WhenJustSynced(t *testing.T) {
    l := Listing{LastSyncedAt: time.Now().Add(-30 * time.Minute)}
    if IsDue(l, time.Hour) {
        t.Error("expected false when last synced 30m ago with 1h interval")
    }
}

// Slice: per-run handler against a fixture-owned temporary SQLite.
func TestRunOnce_UpdatesSyncedAt_ForDueListings(t *testing.T) {
    db := testDB(t) // fixture-owned SQLite, schema from migrations

    old := time.Now().Add(-2 * time.Hour)
    insertListing(t, db, Listing{ID: 1, LastSyncedAt: old})
    insertListing(t, db, Listing{ID: 2, LastSyncedAt: time.Now()}) // not due

    if err := runOnce(context.Background(), db); err != nil {
        t.Fatalf("runOnce: %v", err)
    }

    l1 := selectListing(t, db, 1)
    if !l1.LastSyncedAt.After(old) {
        t.Error("expected LastSyncedAt to be updated for due listing")
    }

    l2 := selectListing(t, db, 2)
    if l2.LastSyncedAt.Before(old.Add(time.Hour)) {
        t.Error("expected LastSyncedAt to be unchanged for non-due listing")
    }
}
```

For host integration, invoke `runOnce` through the production entry point from a
test in `cmd/worker/`, using a fixture-owned SQLite and deterministic clock.
Assert persisted state and emitted calls, reject unexpected network traffic, and
dispose every fixture resource. No Docker or external daemon is required.

Broker delivery, leases, redelivery, ordering, and provider-specific database
behavior require a separate real-provider compatibility suite or are `BLOCKED`.

## Enforcement

Same `enforcement/go/` configuration applies — assert no feature imports another
feature's internals, `internal/db/` imports no feature packages, no ORM or DI
framework imports. Add a job-specific check that every job feature package has
exactly one public `Run` function with the expected signature if you want that
guaranteed mechanically.
