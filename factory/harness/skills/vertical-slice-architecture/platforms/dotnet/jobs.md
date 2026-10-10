# Vertical Slice Architecture — .NET jobs dialect (worker host)

Specializes `core.md` for the worker host (`App.Services`). Job slices follow the
**same VSA rules as HTTP slices** — only the trigger differs: a schedule instead
of a route.

## Noun mapping

| Backbone concept | Jobs form |
|---|---|
| Slice trigger (binding) | The schedule — a `PeriodicTimer` loop in `ExecuteAsync` |
| Slice handler (glue) | The per-run method: open a scope → query → delegate → persist |
| Extracted logic | `*Logic.cs` / `*Rules.cs` static classes (testable without the host) |
| Feature-owned data | `AppDbContext` (shared kernel), resolved per run via a scope |
| Composition root | `Program.cs` selects one job by name arg; `IJob` auto-discovery |
| Shared | `App.Persistence`, plus cross-cutting clients injected via DI |

## Folder shape

```
App.Services/
├── Program.cs                    ← Generic Host; selects ONE job by command arg
├── Jobs/
│   ├── IJob.cs                   ← marker interface (worker analogue of IEndpoint)
│   └── JobExtensions.cs          ← resolves + registers the selected job
└── Features/
    ├── SyncListings/
    │   ├── SyncListingsJob.cs     ← BackgroundService + IJob, owns its schedule
    │   └── ListingSync.cs         ← static decision/calculation logic (testable)
    └── SendDigests/
        └── SendDigestsJob.cs
```

## Rules

- **Every job implements `IJob`** and derives from `BackgroundService`; jobs are
  auto-discovered like `IEndpoint`s.
- **One job per process** — the host selects the job from a command argument
  (`dotnet App.Services.dll sync-listings`); each job is its own Deployment for
  failure isolation.
- **A job owns its schedule** — typically a `PeriodicTimer` loop inside
  `ExecuteAsync`. Catch per-run exceptions so one bad run doesn't kill the pod.
- **`BackgroundService` is a singleton** — open a scope per run via
  `IServiceScopeFactory` to get a scoped `AppDbContext`.
- **Job handlers stay thin** — query → delegate to static logic → persist.
  Extract business logic to static classes exactly as on the HTTP side, so it's
  unit-testable without the host.

### Project and execution gate

When adding a worker project, add it to every repository solution/build entry
point or explicitly build the project itself. A solution build that omits the
worker is not evidence. Before completion, trace one executable path from the
build entry point through the composition root and discovered `IJob` to a
bounded operation and its observable result. The named job must exist, be
discoverable through production registration, and run once through that entry
point; assert its persisted state or emitted boundary call.

```csharp
public class SyncListingsJob : BackgroundService, IJob
{
    private readonly IServiceScopeFactory _scopes;
    public SyncListingsJob(IServiceScopeFactory scopes) => _scopes = scopes;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(15));
        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                using var scope = _scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                var due = await db.Listings.AsNoTracking()
                    .Where(ListingSync.IsDue).ToListAsync(ct);   // extracted predicate/logic
                // ... process, persist ...
            }
            catch (Exception ex) { /* log; do not rethrow — keep the pod alive */ }
        }
    }
}
```

## TDD walkthrough (jobs)

The schedule loop is host plumbing; the **decision/calculation logic is the
testable unit**. Extract it so it's pure, then unit-test it with no host, no
timer, no database (see `core.md` §TDD; cycle in the `tdd` skill).

```csharp
// Unit — extracted logic, plain objects. RED first.
public class ListingSyncTests
{
    [Fact]
    public void IsDue_ReturnsTrue_WhenLastSyncedBeyondInterval()
    {
        var listing = new Listing { LastSyncedAt = DateTime.UtcNow.AddHours(-2) };
        ListingSync.IsDue(listing, interval: TimeSpan.FromHours(1)).Should().BeTrue();
    }
}
```

Per-run handler orchestration (query + persist) is covered with a **slice** test
against a fixture-owned temporary SQLite `AppDbContext`, same as the api dialect.
For host integration, start the real Generic Host in-process and invoke one
registered job execution through its production entry point; do not wait on an
infinite `BackgroundService` schedule loop. Inject a deterministic clock,
fixture-owned HTTP handler, and queue/object-store adapters at their external
boundaries. Assert persisted state and emitted calls, reject unexpected network
traffic, and dispose every fixture resource. No Docker or external daemon is
required. Broker delivery, leases, redelivery, ordering, and provider-specific
database behavior require a separate real-provider compatibility suite or are
`BLOCKED`.

## Enforcement

Same `enforcement/dotnet/architecture-tests.example.cs` applies — assert no slice
references another slice and `App.Persistence` references no feature. Add a job-
specific check that every `IJob` implementation also derives from
`BackgroundService` if you want that guaranteed mechanically.
