# Vertical Slice Architecture — Go API dialect (net/http HTTP host)

Specializes `core.md` for the HTTP host (`cmd/api`). Same four buckets, HTTP
nouns. The API is the *natural* VSA case: one resource ≈ one feature package,
one operation ≈ one slice (a handler function).

## Noun mapping

| Backbone concept | API form |
|---|---|
| Slice trigger (binding) | A `mux.HandleFunc("POST /users", …)` route in `cmd/api/main.go` |
| Slice handler (glue) | `func(w http.ResponseWriter, r *http.Request)` in the feature package |
| Extracted logic | Pure functions in the feature package (`func CanCancel(o Order) bool`) |
| Types / validation | Structs + a `validate` function in the feature package |
| Feature-owned data | `*sql.DB` / `*sql.Tx` injected directly via constructor |
| Composition root | `cmd/api/main.go` — route mounting, middleware, DI |
| Shared | `internal/db/` (connection pool, migrations), `internal/middleware/` |

## Folder shape

```
cmd/api/
├── main.go                     ← composition root: server, routes, middleware, DI
├── routes.go                   ← extracts route registration (keeps main.go thin)
└── middleware.go               ← middleware ordering (logging, recovery, auth)

internal/
├── features/
│   ├── users/                  ← feature: resource, grouped CRUD
│   │   ├── users.go            ← types: User, CreateUserRequest, UserResponse
│   │   ├── create.go           ← handler + extracted logic + validation
│   │   ├── get_by_id.go        ← handler
│   │   ├── search.go           ← handler
│   │   ├── update.go           ← handler
│   │   ├── delete.go           ← handler
│   │   ├── queries.go          ← unexported query helpers (selectUserByID, …)
│   │   ├── create_test.go      ← behavioral test + slice test colocated
│   │   └── get_by_id_test.go
│   └── orders/                 ← larger domain — extracted logic + sub-package
│       ├── orders.go           ← types
│       ├── create.go
│       ├── cancel.go           ← handler: calls CanCancel, persists
│       ├── ship.go
│       ├── state.go            ← decision logic: CanCancel, IsOpen, CanShip
│       ├── pricing.go          ← calculations: CalculateSubtotal
│       └── queries.go          ← query helpers
├── db/
│   ├── db.go                   ← *sql.DB creation, pool config
│   ├── migrate.go              ← runs embedded .sql migration files
│   ├── tx.go                   ← transaction helper (BeginTx wrapper)
│   └── migrations/
│       ├── 001_create_users.sql
│       └── 002_create_orders.sql
└── middleware/
    ├── logging.go
    ├── recovery.go
    └── request_id.go
```

## What goes in each slice file

- **`create.go`** — a package-level handler function (`func CreateUser(w http.ResponseWriter, r *http.Request)`).
  The handler parses the request, validates, calls a query helper, delegates to
  pure logic, persists, writes an HTTP response. No business logic in the
  response-writing boilerplate; no orchestration outside the handler.

```go
// internal/features/users/create.go
package users

import (
    "encoding/json"
    "database/sql"
    "net/http"
)

func CreateUser(db *sql.DB) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        var req CreateUserRequest
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            writeError(w, http.StatusBadRequest, "invalid JSON")
            return
        }
        if err := req.Validate(); err != nil {
            writeError(w, http.StatusUnprocessableEntity, err.Error())
            return
        }

        user := NewUser(req.Name, req.Email)
        if err := insertUser(r.Context(), db, user); err != nil {
            writeError(w, http.StatusInternalServerError, "failed to create user")
            return
        }

        writeJSON(w, http.StatusCreated, ToResponse(user))
    }
}

func GetUserByID(db *sql.DB) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        id, _ := strconv.Atoi(r.PathValue("id"))
        user, err := selectUserByID(r.Context(), db, id)
        if err == sql.ErrNoRows {
            writeError(w, http.StatusNotFound, "user not found")
            return
        }
        if err != nil {
            writeError(w, http.StatusInternalServerError, "query failed")
            return
        }
        writeJSON(w, http.StatusOK, ToResponse(user))
    }
}
```

- **`users.go`** — type definitions: `User` struct, request/response structs,
  validation methods. Keep types flat; no inheritance or interfaces for DTOs.
- **`queries.go`** — unexported functions wrapping raw SQL (`selectUserByID`,
  `insertUser`, `updateUser`, `deleteUser`). Unexported so other features can't
  reach in.

A dense single operation (heavy logic, large request) gets its **own feature
package** instead of a file in a grouped feature — see the split triggers in
`core.md` §Granularity gate. Split it into handler + pure logic sub-packages
only when both hit the gate independently.

## Constructor injection — manual, no framework

Handlers are **closures over their dependencies**, created by a constructor
function. The composition root supplies the concrete `*sql.DB`, and the feature
package receives only what it needs.

```go
// cmd/api/routes.go
func registerRoutes(mux *http.ServeMux, db *sql.DB) {
    mux.HandleFunc("POST /users", users.CreateUser(db))
    mux.HandleFunc("GET /users/{id}", users.GetUserByID(db))
    mux.HandleFunc("GET /users", users.SearchUsers(db))
    mux.HandleFunc("PUT /users/{id}", users.UpdateUser(db))
    mux.HandleFunc("DELETE /users/{id}", users.DeleteUser(db))

    mux.HandleFunc("POST /orders", orders.CreateOrder(db))
    mux.HandleFunc("POST /orders/{id}/cancel", orders.CancelOrder(db))
}
```

A handler that needs multiple dependencies (DB + external client + config) takes
all of them as constructor parameters. No service locator, no `context.Value`
for business dependencies.

```go
func SyncWithCRM(db *sql.DB, crm *crm.Client, cfg Config) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) { ... }
}
```

## Cross-cutting

| Scope | Mechanism | Examples |
|-------|-----------|----------|
| Request-wide | Standard middleware (`func(http.Handler) http.Handler`) | logging, recovery, request ID, CORS |
| Route-group | `http.Handler` wrapping a sub-mux | auth-gated subroutes |
| Never | DI framework interceptors, ORM hooks, AOP | — |

## Nesting

Route depth lives in **composition roots** — `mux.HandleFunc` patterns and
sub-mux mounting — never as structure inside a feature package. Nested resources
(`/orders/{id}/lines`) are expressed by route patterns while each underlying
capability stays a flat handler function in its feature package.

```go
// cmd/api/routes.go — nesting is composition, not package hierarchy
mux.HandleFunc("GET /orders/{id}/lines", orderLines.ListLines(db))
mux.HandleFunc("POST /orders/{id}/lines", orderLines.AddLine(db))
```

## TDD walkthrough (api)

Test through tiers (see `core.md` §TDD; cycle/guardrails in the `tdd` skill).
Prefer the lowest tier that gives signal: extracted logic → **unit**; handler +
DB → **slice**; full contract → **integration**.

The hermetic default uses `httptest.NewServer` with a real `http.ServeMux`
wired identically to production but backed by a fixture-owned temporary SQLite
database. Create the schema from embedded migrations in `TestMain`, reset state
between tests (truncate or recreate), and delete the database on cleanup. Inject
a deterministic `http.RoundTripper` for outbound HTTP; unexpected outbound calls
fail. Do not require Docker, a fixed port, or network egress.

This suite proves routing, middleware, serialization, validation, handler
orchestration, persistence flow, and SQLite query correctness. It does not prove
production-provider migrations or vendor semantics; those belong in a separate
compatibility suite.

```go
// internal/features/orders/state_test.go — RED first
// Unit: extracted decision logic, no infrastructure.
func TestCanBeCancelled_ReturnsFalse_WhenAlreadyShipped(t *testing.T) {
    o := Order{Status: StatusShipped}
    if CanBeCancelled(o) {
        t.Error("expected false for shipped order")
    }
}

// Slice: handler against a fixture-owned temporary SQLite database.
func TestGetUserByID_ReturnsUser_WhenExists(t *testing.T) {
    db := testDB(t) // fixture-owned SQLite, schema from migrations
    user := User{Name: "Test", Email: "test@example.com"}
    insertUser(context.Background(), db, &user)

    handler := GetUserByID(db)
    req := httptest.NewRequest("GET", "/users/1", nil)
    req.SetPathValue("id", "1")
    rec := httptest.NewRecorder()
    handler(rec, req)

    if rec.Code != http.StatusOK {
        t.Fatalf("expected 200, got %d", rec.Code)
    }
}

// Integration: full HTTP round-trip via httptest.Server.
func TestCreateUser_ReturnsCreated(t *testing.T) {
    srv := newTestServer(t) // httptest.NewServer with test DB
    defer srv.Close()

    body := strings.NewReader(`{"name":"Test","email":"t@e.com"}`)
    res, _ := http.Post(srv.URL+"/users", "application/json", body)

    if res.StatusCode != http.StatusCreated {
        t.Fatalf("expected 201, got %d", res.StatusCode)
    }
}
```

Then implement types + handler + queries until green; refactor.

## Enforcement

Use `enforcement/go/` — a `golangci-lint` configuration with `depguard` to
assert: no feature imports another feature's internals, `internal/db/` imports
no feature packages, no import of `gorm.io/gorm` or DI framework modules.
Wire it into CI. See that file.
