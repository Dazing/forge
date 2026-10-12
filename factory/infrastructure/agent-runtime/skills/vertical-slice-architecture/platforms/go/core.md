# Vertical Slice Architecture — Go core conventions (shared backbone)

These rules are dialect-independent. The API and jobs files specialize them with
concrete triggers and folder shapes, but the model below is the contract.

## Why this exists

The goal is **human ownership of code an agent wrote**. Two failure modes break
ownership:

- A change spreads across packages (`handlers → services → repositories`), so
  you can't trace one feature top-to-bottom.
- Cross-feature dependencies hide inside shared services, so you can't tell what
  a change affects elsewhere.

VSA fixes both structurally: a capability lives in one feature package (trace it
in one place), data access is direct (no DAO indirection), and shared logic is
**duplicated, not hoisted** — so coupling stays visible and countable.

## Solution topology

Split by **deployment boundary, not by layer**:

| Package | Role |
|---------|------|
| **`cmd/api/`** | HTTP host — composes feature routes, middleware, `*sql.DB` injection. One binary. |
| **`cmd/worker/`** | Worker host — CLI entrypoints for background jobs. **One binary per job.** |
| **`internal/`** | All business logic, enforced by the Go toolchain — nothing outside the module can import it. |

Both hosts import `internal/` packages; nothing imports a `cmd/` package.
**Never put business logic in `cmd/`** — that rebuilds layered architecture
across processes. Shared logic is duplicated per feature, not hoisted into a
shared service.

> A single binary (just `cmd/api/`) is fine — keep entities/DB in
> `internal/db/` and apply everything else unchanged.

## The four buckets

### 1. Slice — one capability

- A vertical cut through a single thing a user can do.
- Lives **inside a feature package**, typically one `.go` file per operation
  (e.g., `create.go`, `get_by_id.go`).
- Owns its **handler** (orchestration glue), its extracted **logic** (pure
  functions), local **types/validation**, and its **test** (`*_test.go`).
- **May not import another slice's internals.** If two slices need the same
  query, duplicate it. Promote to a shared pure function only for genuine domain
  invariants — never a generic repository/service.

### 2. Feature — a resource package (grouped CRUD)

- `internal/features/{resource}/` groups all operations on a resource:

  ```
  internal/features/users/
  ├── users.go           # types: User, request/response structs, validation
  ├── create.go          # handler + extracted logic (or split if complex)
  ├── get_by_id.go       # handler
  ├── search.go          # handler
  ├── update.go          # handler
  ├── delete.go          # handler
  ├── create_test.go     # behavioral test colocated
  └── queries.go         # shared query helpers (only for this feature, never exported)
  ```

- A typed HTTP client a feature calls out to lives **in the same package**
  (`*_client.go` + its own types), not in a shared services layer.

### 3. Composition root — arranges, doesn't implement

- `cmd/api/main.go` wires routes, middleware, and dependency injection.
- Route grouping (`mux.Handle("GET /users/{id}", ...)`) and prefix mounting —
  **all nesting lives here.** Slices stay flat.
- Holds no business logic.

### 4. Shared kernel — persistence + stateless plumbing only

Allowed:
- **`internal/db/`** — `*sql.DB` creation, connection pool config, migration
  runner, query helpers (pure, not feature-aware).
- **`internal/middleware/`** — request logging, recovery, auth extraction,
  CORS.

Forbidden:
- **Business logic or services in the kernel.** A pricing rule, a state check,
  an aggregation belongs to a slice (extracted to a pure function), never to
  `internal/db/` or a shared service. This is the rule that stops the kernel
  becoming a layered back door.
- **Repository abstractions.** Inject `*sql.DB` or `*sql.Tx` directly.

## Quick reference

| Rule | Convention |
|------|------------|
| Feature layout | One Go package per resource; one `.go` file per operation |
| Handler pattern | `func(w http.ResponseWriter, r *http.Request)` — plain `http.HandlerFunc` |
| Data access | Inject `*sql.DB` / `*sql.Tx` directly — no repositories, no ORM |
| Decision logic | Pure function with explicit inputs (`func CanBeCancelled(o Order) bool`) |
| Calculations | Pure function with plain data inputs |
| Query helpers | Unexported functions in the feature package; reuse via duplication |
| Validation | Inline in the handler or a package-level `validate` function |
| Cross-cutting | Middleware (request-wide), constructor injection for clients |
| Domain layer | None — types are plain structs in the feature package |
| DI framework | Never — manual constructor injection; no wire, dig, fx |
| ORM | Never — `database/sql` directly; no GORM, sqlx for scanning at most |

## Business logic extraction

The handler is **orchestration glue only**: receive request → parse/validate →
query data → delegate logic → persist → write response.

```go
// Decision logic & state checks → pure function with EXPLICIT input
func CanBeCancelled(o Order) bool {
    return o.Status != StatusShipped && o.Status != StatusDelivered
}

// Calculations → pure functions on plain data
func CalculateSubtotal(lines []OrderLine) decimal.Decimal {
    var total decimal.Decimal
    for _, l := range lines {
        total = total.Add(l.Price.Mul(decimal.NewFromInt(int64(l.Qty))))
    }
    return total
}

// Query helpers → unexported functions in the feature package
func selectUserByID(db *sql.DB, id int) (*User, error) { ... }
func selectActiveUsers(db *sql.DB, limit, offset int) ([]User, error) { ... }
```

| Concern | Pattern | Why |
|---------|---------|-----|
| Decision logic | Package-level pure function | Explicit dependency, groups related rules |
| Calculations | Package-level pure function | Plain data inputs, trivially testable |
| Query helpers | Unexported function (raw SQL) | No ORM indirection; duplicated per feature |

## Data access rules

- **No repository pattern** — `*sql.DB` / `*sql.Tx` directly.
- **Reads** use `db.QueryContext` / `db.QueryRowContext` with raw SQL;
  `sqlx.StructScan` is allowed for mapping convenience, never for query
  building.
- **Writes** use `db.ExecContext`; wrap in a transaction (`db.BeginTx`) when
  multi-row consistency is required.
- **Raw SQL, hand-written.** No query builder, no ORM migration tool.
  Migrations are `.sql` files in `internal/db/migrations/` run by a
  file-system embed.

## The granularity gate

> If you can't write a meaningful failing test for it, it's not a slice.

Start grouped. **Split** a single-file feature into separate operation files or
sub-packages only when:

- A handler function exceeds **~60 lines** of logic (not boilerplate).
- An operation pulls in **unrelated dependencies** (external APIs, file storage,
  queues).
- Shared business logic grows **complex enough for its own testable units**.
- A single operation has **more than 3–4 request/response types**.

## TDD loop (per slice) & test tiers

Build each slice test-first: **Red** (write the behavioral test, watch it fail) →
**Green** (minimal handler/logic to pass) → **Refactor** (clean up, stays green).
The cycle, evidence rules, and subagent test-authoring discipline are in the
**`tdd`** skill. The Go tiers:

| Tier | Location | What it tests | Setup |
|------|----------|---------------|-------|
| **Unit** | `*_test.go` (same package) | Extracted pure functions, calculators | Plain data, no infrastructure |
| **Slice** | `*_test.go` (same package) | Handler logic with SQL data access | Fixture-owned temporary SQLite via `database/sql` driver |
| **Integration** | `cmd/api/` or `internal/apitest/` | Full HTTP round-trip | `httptest.NewServer` + fixture-owned temporary SQLite |

Pure functions must be testable **without a database, without an HTTP server** —
that's the signal the logic was extracted correctly. The dialect files show
worked tests.

Hermetic tests require no Docker or external service. Use a unique file-backed
SQLite database per test or test suite, create the schema from embedded
migrations, reset state between tests, and delete the file on cleanup. The
`database/sql` SQLite driver provides relational behavior without external
daemons.

`host+db` setup MUST name SQLite and the reset lifecycle. SQLite proves
application flow and SQL query correctness; it does not prove
production-provider migrations, provider-specific SQL/types, collation,
transaction isolation, or locking. Those require a separately available
real-provider compatibility suite or are `BLOCKED`.

```bash
go test ./internal/features/orders/ -run TestCanBeCancelled   # inner loop (fast)
go test ./internal/features/orders/                           # feature completion
go test ./...                                                  # final verification
```

## Dependency rules (what enforcement encodes)

1. `slice → slice`: **forbidden.**
2. `slice → internal/db/`: allowed (DB + types, direct).
3. `internal/db/ → features`: **forbidden** (kernel knows nothing about features).
4. Feature → another feature's internals: **forbidden** — duplicate instead.
5. `cmd/` → business logic: **forbidden** — `cmd/` is composition only.
6. No reference to ORMs (`gorm.io/gorm`), DI frameworks (`uber-go/fx`,
   `google/wire`), or layer packages (`services/`, `repositories/`).

`internal/` already enforces module-visibility (nothing outside the module can
import it). Within `internal/`, use `golangci-lint` with `depguard` or a custom
analyser for feature-boundary rules. See `enforcement/go/`.

## Review checklist (how the human keeps ownership)

- Does the change touch **one feature package** (plus maybe `cmd/api/main.go`
  wiring)? If it's smeared across many, the slice boundary is wrong.
- Is there a **colocated `*_test.go`** that reads as the spec, in the right tier?
- Is the handler **orchestration glue only**, with logic in testable pure
  functions?
- Did any **business logic leak into `internal/db/`** or a shared service? Move
  it into the feature package (duplicate if needed).
- Is new **nesting** a route prefix in a composition root, not structure inside a
  feature package?
