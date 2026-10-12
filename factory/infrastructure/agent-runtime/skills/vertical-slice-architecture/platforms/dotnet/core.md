# Vertical Slice Architecture — .NET core conventions (shared backbone)

These rules are host-independent. The API and jobs files specialize them with
concrete triggers and folder shapes, but the model below is the contract.

## Why this exists

The goal is **human ownership of code an agent wrote**. Two failure modes break
ownership:

- A change spreads across layers (`Controllers → Services → Repositories`), so
  you can't trace one feature top-to-bottom.
- Cross-feature dependencies hide inside shared services, so you can't tell what
  a change affects elsewhere.

VSA fixes both structurally: a capability lives in one feature folder (trace it
in one place), data access is direct (no repository indirection), and shared
logic is **duplicated, not hoisted** — so coupling stays visible and countable.

## Solution topology

Split by **deployment boundary, not by layer**:

| Project | Role |
|---------|------|
| **`App.Api`** | HTTP host — VSA HTTP slices (`IEndpoint`). One image, one Deployment. |
| **`App.Services`** | Worker host — VSA job slices (`IJob`). One image, **one Deployment per job**. |
| **`App.Persistence`** | Shared kernel — `AppDbContext`, entities, EF configs. **Persistence only.** |

`App.Api` and `App.Services` both reference `App.Persistence`; nothing references
them. Each applies the VSA rules below internally. **Never put business logic or
services in `App.Persistence`** — that rebuilds layered architecture across
processes. Shared logic is duplicated per slice, not hoisted into the kernel.

> A single-deployable project (just `App.Api`) is fine — keep entities/DbContext
> in a `Data/` or `Persistence/` folder and apply everything else unchanged.

## The four buckets

### 1. Slice — one capability

- A vertical cut through a single thing a user can do.
- Lives **inside a feature folder**; by default it's a `private static` handler
  method on the feature's `IEndpoint`/`IJob` class — not its own folder.
- Owns its **trigger** (route or schedule), its **handler** (orchestration glue),
  its extracted **logic** (static classes), local **DTOs/validators**, and its
  **test**.
- **May not reference another slice.** If two slices need the same query,
  duplicate it. Promote to a shared static helper only for genuine domain
  invariants — never a generic repository/service.

### 2. Feature — a resource folder (grouped CRUD)

- `Features/{Resource}/` groups all operations on a resource:

  ```
  Features/Users/
  ├── UsersFeature.cs       # IEndpoint: GetById, Search, Create, Update, Delete
  ├── UserDtos.cs           # All request/response records for this resource
  └── UserValidators.cs     # FluentValidation validators
  ```

- A typed HTTP client a feature calls out to lives **in the same folder**
  (`*Client.cs` + its own `*Dtos.cs`), not in a shared services layer.

### 3. Composition root — arranges, doesn't implement

- `Program.cs` plus **assembly-scanning auto-discovery** of `IEndpoint`/`IJob`
  implementations — no manual registration per slice.
- Route grouping (`app.MapGroup("/users")`) and route prefixes — **all nesting
  lives here.** Slices stay flat.
- Holds no business logic.

### 4. Shared kernel — persistence + stateless plumbing only

Allowed:
- **`App.Persistence`** — `AppDbContext`, EF entities (`Entities/`), Fluent API
  configs (`Configurations/`), migrations + generated SQL scripts.
- **`Infrastructure/`** (per host) — middleware (request-wide), endpoint filters
  (route-scoped), cross-cutting clients injected via DI.

Forbidden:
- **Business logic or services in the kernel.** A pricing rule, a state check,
  an aggregation belongs to a slice (extracted to a static class), never to
  `App.Persistence` or a shared service. This is the rule that stops the kernel
  becoming a layered back door.
- **Repository abstractions.** Inject `AppDbContext` directly.

## Quick reference

| Rule | Convention |
|------|------------|
| Feature layout | Grouped CRUD: `*Feature.cs` + `*Dtos.cs` + `*Validators.cs` per resource |
| Endpoint/job pattern | `IEndpoint` / `IJob` with `private static` handler methods |
| Data access | Inject `AppDbContext` directly — no repositories |
| Decision logic | Static class with static methods (`OrderState.CanBeCancelled(order)`) |
| Calculations | Static class with plain data inputs |
| Query projections | Extension methods on `IQueryable<T>` |
| Validation | FluentValidation, validated inline in the handler |
| Cross-cutting | Middleware (request-wide), endpoint filters (route-scoped) |
| Domain layer | None — entities are EF models in `App.Persistence/Entities/` |
| MediatR | Never — no mediator, no dispatcher, no pipeline behaviors |

## Business logic extraction

The handler is **orchestration glue only**: receive request → query data →
delegate logic → persist → return result.

```csharp
// Decision logic & state checks → static class with EXPLICIT input
public static class OrderState
{
    public static bool CanBeCancelled(Order order) => ...;
}
// ❌ not an extension method — `this Order` hides the dependency

// Calculations → static methods on plain data (not DbContext/entities)
public static class PricingCalculator
{
    public static decimal CalculateSubtotal(IEnumerable<OrderLine> lines) => ...;
}

// Query projections → IQueryable<T> extension methods (compose with LINQ, EF-translatable)
public static IQueryable<OrderSummary> AsSummary(this IQueryable<Order> q) => ...;
public static IQueryable<Order> WhereStatus(this IQueryable<Order> q, OrderStatus? s) => ...;
// Usage: db.Orders.WhereStatus(status).AsSummary().ToListAsync(ct);
```

| Concern | Pattern | Why |
|---------|---------|-----|
| Decision logic | `static class` + `static` methods | Explicit dependency, groups related rules |
| Calculations | `static class` + `static` methods | Plain data inputs, trivially testable |
| Query projections | Extension methods on `IQueryable<T>` | Composes with LINQ, EF-translatable |

## Data access rules

- **No repository pattern** — `AppDbContext` directly.
- **Reads** use `.AsNoTracking()` and project to response DTOs with `.Select()`.
- **Writes** use `FindAsync()` or query + mutate + `SaveChangesAsync()`; wrap in
  a transaction when multi-row consistency is required. Bulk deletes use
  `ExecuteDeleteAsync()`.
- Entities are EF models in `App.Persistence/Entities/`; EF configs in
  `Configurations/` via `IEntityTypeConfiguration<T>`. **Schema is hand-written
  SQL** in `App.Persistence/Scripts/` — no EF Core migrations.

## The granularity gate

> If you can't write a meaningful failing test for it, it's not a slice.

Start grouped. **Split** a grouped CRUD folder into sub-slices or single-
operation files only when:

- A handler method exceeds **~60 lines** of logic (not boilerplate).
- An operation pulls in **unrelated dependencies** (external APIs, file storage,
  queues).
- Shared business logic grows **complex enough for its own testable units**.
- A single operation has **more than 3–4 request/response models**.

## TDD loop (per slice) & test tiers

Build each slice test-first: **Red** (write the behavioral test, watch it fail) →
**Green** (minimal handler/logic to pass) → **Refactor** (clean up, stays green).
The cycle, evidence rules, and subagent test-authoring discipline are in the
**`tdd`** skill. The .NET tiers:

| Tier | Project | What it tests | Setup |
|------|---------|---------------|-------|
| **Unit** | `App.Tests.Unit` | Extracted static logic, calculators | Plain objects, no infrastructure |
| **Slice** | `App.Tests.Slice` | Handler logic with relational data access | Fixture-owned temporary SQLite `AppDbContext` |
| **Integration** | `App.Tests.Integration` | Full HTTP round-trip | `WebApplicationFactory<Program>` + fixture-owned temporary SQLite |

Use xUnit + FluentAssertions. Extracted logic must be testable **without mocks,
without an in-memory database, without `WebApplicationFactory`** — that's the
signal it was extracted correctly. The dialect files show worked tests.

Hermetic tests require no Docker or external service. Prefer a unique
file-backed SQLite database per fixture/test collection so host-created
`AppDbContext` scopes share one relational store without connection-lifetime
tricks. The fixture creates the schema, resets state between tests, deletes the
file on disposal, and states its parallelism rule. SQLite in-memory is allowed
only when one explicitly owned open connection spans every context that needs
the database. EF Core's `InMemory` provider is prohibited for relational
behavior.

`host+db` setup MUST name SQLite and the reset lifecycle. SQLite proves
application flow and SQLite query translation; it does not prove production
migrations, provider-specific SQL/types/extensions, collation, transaction
isolation, or locking. Those require a separately available real-provider
compatibility suite or are `BLOCKED`.

```bash
dotnet test tests/App.Tests.Unit --filter OrderStateTests   # inner loop (fast)
dotnet test tests/App.Tests.Unit                            # tier completion
dotnet test                                                 # final verification
```

## Dependency rules (what enforcement encodes)

1. `slice → slice`: **forbidden.**
2. `slice → App.Persistence`: allowed (DbContext + entities, direct).
3. `App.Persistence → Features / Infrastructure`: **forbidden** (kernel knows
   nothing about features).
4. Feature → another feature's internals: **forbidden** — duplicate instead.
5. No reference to `MediatR`, no `Domain`/`Application`/`Infrastructure` **layer
   projects**.

These are mechanical and belong in CI — see `enforcement/`.

## Review checklist (how the human keeps ownership)

- Does the change touch **one feature folder** (plus maybe `Program.cs` wiring)?
  If it's smeared across many, the slice boundary is wrong.
- Is there a **test** that reads as the spec, in the right tier?
- Is the handler **orchestration glue only**, with logic in testable static
  classes?
- Did any **business logic leak into `App.Persistence`** or a shared service?
  Move it into the slice (duplicate if needed).
- Is new **nesting** a route prefix in a composition root, not structure inside a
  slice?
