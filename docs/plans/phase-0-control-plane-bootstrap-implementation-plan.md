# Implementation Plan: Phase 0 control-plane bootstrap

## Outcome
A compilable Go `orchestrator/` service exposes liveness/readiness, applies SQLite migrations before readiness, and owns the Phase 0 module and data-model boundaries.

## Acceptance criteria
- `orchestrator/` builds and starts only after applying SQLite migrations with WAL mode, foreign keys, and `busy_timeout` enabled.
- `GET /health/live` reports process/event-loop liveness; `GET /health/ready` reports `503` until the database migration/read-write probe, GitLab token probe, publisher socket probe, and forced-command worker probe succeed.
- Every design §7.1 module has a named internal Go package; large payload fields are represented by bounded artifact references rather than unbounded transcript blobs.
- Initial migration defines the Phase 0 tables and uniqueness keys required by `webhook_delivery`, `project`, `work_item`, `dependency`, `plan`, `run`, `merge_request`, `review`, `lease`, `transition`, `action`, and `release_candidate`.

## Required skills
- `tdd` — use for the migration, readiness-state, and HTTP-status contracts before implementing their Go code.
- `vertical-slice-architecture` — governs the module/package layout, composition-root wiring, and slice boundary rules described in the "Vertical-slice architecture" section of this plan.

## Repository findings
- `docs/roadmap.md: Phase 0` — requires a single orchestrator skeleton, SQLite WAL migrations, foreign keys, UTC timestamps, bounded payload references, idempotent action records, and operational runbooks.
- `docs/technical-design.md: §7.1–§7.2` — fixes the eleven module names, single-process boundary, SQLite settings, table names, and key fields.
- `docs/technical-design.md: §7.6` — fixes the health endpoint paths and readiness dependencies.

## Assumptions
- Use Go for trusted services, selected by the user; make `orchestrator` an independent Go module with module path `factory.local/platform/orchestrator` until Phase 1 assigns its GitLab path.
- Phase 0 implements persistence and readiness only; GitLab mutations, scheduling, reconciliation, and release execution remain later-phase behavior.


## Vertical-slice architecture
- This plan establishes composition-root and shared-infrastructure foundations for the orchestrator; it does not claim the placeholder packages are slices.
- The first future orchestrator slices are `receive-gitlab-webhook`, `admit-ready-work-item`, `reconcile-factory-state`, and `dispatch-planning-run`. Each slice will colocate its route/event binding, validation, handler/orchestration logic, store mapping, and behavioral test.
- `store`, `config`, and `health` remain shared/platform plumbing. They must not own workflow state or import feature-specific logic.
- `cmd/factory-orchestrator` and the HTTP/router wiring are composition-root code. Slice packages must not import one another directly; later cross-slice coordination is exposed through explicit contracts assembled at the root.
- Phase 0 acceptance is limited to proving the boundaries, schema, and readiness behavior; no empty module package is treated as a completed capability.

## Boundaries
### In scope
- `orchestrator/` Go module, migration runner, initial SQLite schema, internal module package layout, health HTTP server, typed configuration, and operator runbooks.

### Out of scope
- Webhook processing, GitLab API mutations, scheduling, model calls, launch dispatch, patch publication, deployment triggers, metrics collection, and production operations.

### Must preserve
- One deployable service with internal modules, not microservices or a queue product.
- UTC timestamps; foreign-key enforcement; short-lived bounded database values; GitLab remains authoritative when workflow logic is added later.

## Contracts and behavior
- `cmd/factory-orchestrator/main.go` loads `config.Config`, opens the configured SQLite file, runs ordered SQL migrations exactly once each, and constructs `http.Server`.
- `config.Config` includes database path, `busy_timeout`, GitLab health-probe configuration, publisher Unix-socket path, and worker forced-command probe configuration. Secrets are supplied by environment variable names, never logged or persisted.
- `health.Checker` returns a per-dependency result. `/health/live` returns `200` while the process can serve; `/health/ready` returns `200` only when all four required probes pass, otherwise `503` with no secret values.
- Migrations store `*_at` values as UTC RFC 3339 strings. `webhook_delivery.delivery_id`, `action.idempotency_key`, and the composite primary keys specified in design §7.2 enforce their deduplication boundaries. `payload_json` is size-capped by application validation; transcript/log columns do not exist.

## Implementation steps
1. **Create the orchestrator module and configuration boundary**
   - Files: `orchestrator/go.mod`, `orchestrator/cmd/factory-orchestrator/main.go`, `orchestrator/internal/config/config.go`, `orchestrator/README.md`
   - Symbols: `config.Config`, `config.Load() (Config, error)`, `main()`.
   - Change: Define the independent Go module, parse only required configuration, start the HTTP server, and document local startup plus required environment-variable names.
   - Preserve: Do not add a queue, generic plugin framework, credential persistence, or workflow mutation endpoint.
   - Depends on: None.
2. **Create the Phase 0 module packages and SQLite migration contract**
   - Files: `orchestrator/internal/{webhook,gitlab,projector,policy,scheduler,launcher,adapter,publisher,reconciler,reporter,release}/doc.go`, `orchestrator/internal/store/store.go`, `orchestrator/migrations/001_initial.sql`, `orchestrator/internal/store/store_test.go`
   - Symbols: `store.Open(ctx context.Context, path string, busyTimeout time.Duration) (*Store, error)`, `store.Migrate(ctx context.Context) error`.
   - Change: Add documentation-only package declarations for the eleven modules; open SQLite with WAL, foreign keys, and configured busy timeout; apply the initial schema with all §7.2 tables, foreign keys, primary/unique keys, and bounded-reference columns.
   - Preserve: Do not implement deferred workflow behavior behind placeholder actions; migration failure prevents service readiness.
   - Depends on: 1.
3. **Expose liveness and dependency-gated readiness**
   - Files: `orchestrator/internal/health/checker.go`, `orchestrator/internal/httpserver/server.go`, `orchestrator/internal/health/checker_test.go`, `orchestrator/internal/httpserver/server_test.go`
   - Symbols: `health.Checker`, `health.Dependency`, `httpserver.New(checker *health.Checker) http.Handler`.
   - Change: Implement `GET /health/live` and `GET /health/ready`; make readiness probe migrated/writable SQLite plus configured GitLab, publisher-socket, and worker reachability probes; redact failure detail to dependency names/status only.
   - Preserve: `/health/ready` has no route that can approve, merge, deploy, or mutate GitLab.
   - Depends on: 2.
4. **Record Phase 0 operational procedures**
   - Files: `orchestrator/runbooks/startup.md`, `orchestrator/runbooks/migrations.md`, `orchestrator/runbooks/readiness.md`
   - Symbols: None.
   - Change: Document migration-before-readiness startup, non-destructive readiness diagnosis, database backup precondition, and the meaning of each health status.
   - Preserve: Runbooks never instruct operators to delete the SQLite database or bypass failed migrations.
   - Depends on: 3.

## Caller and dependency updates
- `launcher/` — later execution-boundary code supplies the worker probe target; this plan only consumes configured reachability.
- `publisher/` — later publisher code supplies the configured Unix socket; this plan only probes it.
- `agent-assets/schemas/` — later assets plan defines result schemas consumed by the future adapter; no runtime dependency is introduced in Phase 0.

## Verification
- Command: `go test ./orchestrator/...`
- Proves: migrations enforce SQLite settings and key constraints, and liveness/readiness emit the required status transitions.
- Success evidence: exit status 0 with all `orchestrator` package tests passing.
- Not covered: live GitLab, publisher, and worker network integration; probes use local test doubles.

## Executor constraints
- Treat this file as the complete implementation specification; do not reopen the original request.
- Read the named target files before editing, but do not repeat the planner's discovery searches.
- Follow the named files, symbols, contracts, steps, boundaries, and verification command exactly.
- Do not add work not listed under **In scope**.
- If the repository no longer matches a stated finding, stop expanding the search, report the exact discrepancy, and make only the smallest inspection needed to resolve it.
- Load every skill under **Required skills** before editing. Load an additional skill only when new repository evidence makes it applicable; do not use skill loading to restart research.
- After the focused verification passes, stop. Do not run broader checks or continue polishing.
