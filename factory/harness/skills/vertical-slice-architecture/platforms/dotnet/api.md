# Vertical Slice Architecture — .NET API dialect (ASP.NET HTTP host)

Specializes `core.md` for the HTTP host (`App.Api`). Same four buckets, HTTP
nouns. The API is the *natural* VSA case: one resource ≈ one feature folder, one
operation ≈ one slice (a handler method).

## Noun mapping

| Backbone concept | API form |
|---|---|
| Slice trigger (binding) | A `MapGet/MapPost/...` route on the feature's `IEndpoint` |
| Slice handler (glue) | `private static async Task<IResult>` method on the feature class |
| Extracted logic | `*State.cs` / `*Calculator.cs` static classes; `*Projections.cs` `IQueryable` extensions |
| DTOs / validation | `*Dtos.cs` (records) + `*Validators.cs` (FluentValidation) |
| Feature-owned data | `AppDbContext` (shared kernel), injected directly |
| Composition root | `Program.cs` + `IEndpoint` auto-discovery; nesting = route groups/prefixes |
| Shared | `App.Persistence` (DbContext, entities), `Infrastructure/` (middleware, filters) |

## Folder shape

```
App.Api/
├── Program.cs                    ← composition root: host, DI, middleware pipeline
├── Endpoints/
│   └── EndpointExtensions.cs     ← auto-registers all IEndpoint implementations
├── Features/
│   ├── Users/                    ← feature: resource, grouped CRUD
│   │   ├── UsersFeature.cs       ← IEndpoint: GetById, Search, Create, Update, Delete
│   │   ├── UserDtos.cs           ← request/response records
│   │   └── UserValidators.cs     ← FluentValidation validators
│   └── Orders/                   ← larger domain — extracted logic + a sub-slice
│       ├── OrdersFeature.cs
│       ├── OrderDtos.cs
│       ├── OrderValidators.cs
│       ├── OrderState.cs         ← decision logic (CanBeCancelled, IsOpen)
│       ├── OrderProjections.cs   ← IQueryable extensions (AsSummary, WhereStatus)
│       └── Pricing/              ← sub-slice: split out only when genuinely complex
│           ├── PricingCalculator.cs
│           └── DiscountRules.cs
└── Infrastructure/               ← cross-cutting plumbing
    ├── Logging/RequestLoggingMiddleware.cs
    ├── Validation/ValidationFilter.cs
    └── Errors/ProblemDetailsMiddleware.cs
```

`App.Persistence/` (DbContext, `Entities/`, `Configurations/`, migrations) is the
shared kernel both hosts reference. See `core.md` §Solution topology.

## What goes in each slice

- **`UsersFeature.cs`** implements `IEndpoint`; `MapRoutes` declares the routes in
  a group, each pointing at a `private static` handler. The handler validates,
  queries `AppDbContext`, delegates to static logic, persists, returns `IResult`.
  No business logic in the route declaration; no orchestration outside the
  handler.

```csharp
public class UsersFeature : IEndpoint
{
    public void MapRoutes(IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/users").WithTags("Users");
        group.MapGet("/{id:int}", GetById);
        group.MapPost("/", Create);
        // ... Search, Update, Delete
    }

    private static async Task<IResult> GetById(int id, AppDbContext db, CancellationToken ct)
    {
        var user = await db.Users.AsNoTracking()
            .Where(u => u.Id == id)
            .Select(u => new UserResponse(u.Id, u.Name, u.Email))
            .FirstOrDefaultAsync(ct);
        return user is null ? Results.NotFound() : Results.Ok(user);
    }

    private static async Task<IResult> Create(
        CreateUserRequest request, AppDbContext db,
        IValidator<CreateUserRequest> validator, CancellationToken ct)
    {
        var validation = await validator.ValidateAsync(request, ct);
        if (!validation.IsValid)
            return Results.ValidationProblem(validation.ToDictionary());

        var user = new User(request.Name, request.Email);
        db.Users.Add(user);
        await db.SaveChangesAsync(ct);
        return Results.Created($"/users/{user.Id}", new UserResponse(user.Id, user.Name, user.Email));
    }
}
```

- **`UserDtos.cs`** — request/response `record`s, positional for simple shapes.
- **`UserValidators.cs`** — `AbstractValidator<T>` per request, validated inline.

A dense single operation (heavy logic, large request) gets its **own slice class**
(`GenerateMonthlySalesReport : IEndpoint`) instead of a method on a grouped
feature — see the split triggers in `core.md` §Granularity gate.

Choose feature ownership by the capability or resource being created or
changed, not merely the first route segment or parent identifier. For example,
creating a delivery through `/depots/{depotId}/deliveries` belongs to the
Deliveries feature unless repository-local rules explicitly assign that
capability elsewhere. A dense external-provider operation gets a dedicated
slice class under its owned feature; check the namespace against repository
architecture enforcement before wiring the endpoint.

## Cross-cutting

| Scope | Mechanism | Examples |
|-------|-----------|----------|
| Request-wide | ASP.NET **middleware** | logging, error handling, correlation IDs |
| Route/group-scoped | **endpoint filters** | validation, authorization |
| Never | pipeline behaviors, action filters, MediatR | — |

## Nesting

Route depth lives in **composition roots** — `MapGroup` and route prefixes —
never as structure inside a slice. Nested resources
(`/orders/{id}/lines`) are expressed by route composition while each underlying
capability stays a flat handler method (or sub-slice when complex).

## TDD walkthrough (api)

Test through tiers (see `core.md` §TDD; cycle/guardrails in the `tdd` skill).
Prefer the lowest tier that gives signal: extracted logic → **unit**; handler +
DB → **slice**; full contract → **integration**.

The hermetic default uses the real `WebApplicationFactory<Program>` pipeline and
a custom factory that replaces only the production database registration with a
fixture-owned temporary SQLite database. It creates the schema, exposes one
client, resets state between tests, and deletes the database on disposal. Use a
test authentication handler or locally signed token for policy tests and an
injected `HttpMessageHandler` for outbound HTTP; unexpected outbound calls fail.
Do not require Docker, a fixed port, or network egress.

This suite proves routing, middleware, serialization, validation, authorization
policy, handler orchestration, persistence flow, and SQLite translation. It does
not prove production-provider migrations or vendor semantics; those belong in a
separate compatibility suite.

```csharp
// Unit — extracted decision logic, no infrastructure. RED first.
public class OrderStateTests
{
    [Fact]
    public void CanBeCancelled_ReturnsFalse_WhenAlreadyShipped()
    {
        var order = new Order { Status = OrderStatus.Shipped };
        OrderState.CanBeCancelled(order).Should().BeFalse();
    }
}

// Slice — handler against a fixture-owned temporary SQLite AppDbContext.
[Fact]
public async Task GetById_ReturnsUser_WhenExists()
{
    var user = new User("Test", "test@example.com");
    _db.Users.Add(user); await _db.SaveChangesAsync();

    var result = await _db.Users.AsNoTracking()
        .Where(u => u.Id == user.Id)
        .Select(u => new UserResponse(u.Id, u.Name, u.Email))
        .FirstOrDefaultAsync();

    result!.Name.Should().Be("Test");
}

// Integration — full HTTP round-trip via WebApplicationFactory<Program>.
[Fact]
public async Task GetById_ReturnsOk_WhenUserExists()
{
    var created = await _client.PostAsJsonAsync("/users", new { Name = "Test", Email = "t@e.com" });
    var body = await created.Content.ReadFromJsonAsync<UserResponse>();

    var res = await _client.GetAsync($"/users/{body!.Id}");
    res.StatusCode.Should().Be(HttpStatusCode.OK);
}
```

Then implement route + DTOs + validator + handler until green; refactor.

## Enforcement

Use `enforcement/dotnet/architecture-tests.example.cs` (NetArchTest) to assert: no slice
references another slice, `App.Persistence` references no feature, no reference to
`MediatR`. Wire it into the test suite. See that file.
