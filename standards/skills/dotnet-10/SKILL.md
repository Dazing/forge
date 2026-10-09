---
name: dotnet-10
description: Bridges the knowledge gap for models trained on .NET 8 when generating .NET 10 code. Covers .NET 9 + 10 platform changes, ASP.NET Core, EF Core, and the user's stack; pairs with `csharp` for language guidance. Accuracy-first — when unsure, search current documentation.
---

# .NET 10 Development Guide

## ⚠️ Knowledge Boundary

**You were trained on .NET 8. You do NOT natively know .NET 9 or .NET 10 APIs.** .NET 10 is an LTS release (November 2025). This file bridges the gap.

### Critical Rules

1. **NEVER invent .NET 9/10 APIs.** If unsure whether an API exists, **search `learn.microsoft.com`** before generating code.
2. **When searching isn't possible**, fall back to the .NET 8 pattern and annotate: `// TODO: Verify in .NET 10 — model trained on .NET 8`.
3. **Prefer the modern idiom** when you know it from this file.
4. **Load `skill://csharp` for every C# contribution.** It is the canonical source for general C# practices and version-gated C# 12-14 features.

---

## Target Framework & csproj Template

Always use `net10.0`. Never generate `net8.0` or `net9.0` unless the user explicitly targets those.

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <GenerateDocumentationFile>true</GenerateDocumentationFile>
  </PropertyGroup>
</Project>
```

NuGet packages: use version `10.0.0` for all `Microsoft.*` packages. Do not reference `8.x` packages on `net10.0`.

---

## Key Breaking Changes (from .NET 8 baseline)

> **Read this section first.** These cause compile errors or silent behavioral bugs.

### Source-Incompatible

#### EF Core `ExecuteUpdateAsync` signature changed

```csharp
// ❌ WRONG — .NET 8 pattern, won't compile in EF Core 10
// Signature was Expression<Func<...>>, now it's Func<>
await db.Posts.ExecuteUpdateAsync(s => s.SetProperty(x => x.Title, "New"));

// ✅ RIGHT — EF Core 10 uses Func<>, supports statements
await db.Posts.ExecuteUpdateAsync(s => {
    s.SetProperty(x => x.Title, "New");
});

// ✅ Also valid — conditional logic now works
await db.Posts.ExecuteUpdateAsync(s => {
    s.SetProperty(x => x.Title, "New");
    if (updateDate) s.SetProperty(x => x.ModifiedAt, DateTime.UtcNow);
});
```

#### Swashbuckle is dead — use built-in OpenAPI

```csharp
// ❌ WRONG — Swashbuckle removed from templates
builder.Services.AddSwaggerGen();
app.UseSwagger();
app.UseSwaggerUI();

// ✅ RIGHT — Built-in OpenAPI (Microsoft.AspNetCore.OpenApi package)
builder.Services.AddOpenApi();
app.MapOpenApi();
// Serves OpenAPI 3.1 JSON at /openapi/v1.json
// YAML: app.MapOpenApi("/openapi/{documentName}.yaml");
```

`OpenApiAny` is gone — use `JsonNode` in OpenAPI transformers.

#### `System.Linq.AsyncEnumerable` now in core

Remove the NuGet package reference — it conflicts with the built-in type.

#### `BinaryFormatter` removed

Was deprecated; now gone entirely in .NET 9+.

### Behavioral

- **Cookie auth returns 401/403** for `[ApiController]`, Minimal API, SignalR, and `TypedResults` endpoints instead of redirecting to login. Override `OnRedirectToLogin` / `OnRedirectToAccessDenied` if you need old behavior.
- **EF Core JSON columns** auto-migrate to native `json` type on Azure SQL / SQL Server 2025. Pin with `.HasColumnType("nvarchar(max)")` if not ready.
- **`Microsoft.Data.Sqlite`** UTC handling changed for `DateTime`/`DateTimeOffset`. Set `Microsoft.Data.Sqlite.Pre10TimeZoneHandling` AppContext switch to revert.
- **SignalR** strongly-typed hubs not supported with Native AOT (`PublishAot`).

---

## C# language guidance

Load **`skill://csharp`** before contributing C# code. That skill owns the
prescriptive language baseline and version-gated C# 12-14 guidance. It checks
the effective TFM and `LangVersion` before recommending newer syntax; this guide
does not duplicate those rules.

---

## ASP.NET Core 10

### Built-in Minimal API validation

```csharp
// Setup
builder.Services.AddValidation();

// Automatically validates DataAnnotations on parameters.
// Returns 400 + ProblemDetails on failure.
// Disable per-endpoint:
app.MapPost("/items", (Item item) => { ... }).DisableValidation();
```

For nested/complex objects: mark root model with `[ValidatableType]`. Define models in `.cs` files (source generator requires it, not `.razor`).

### Server-Sent Events

```csharp
app.MapGet("/events", () =>
    TypedResults.ServerSentEvents(GetEventsAsync(), eventType: "update"));

async IAsyncEnumerable<SseItem<string>> GetEventsAsync() { ... }
```

### OpenAPI

- Default version: **OpenAPI 3.1** (JSON Schema draft 2020-12).
- Use `Microsoft.AspNetCore.OpenApi` — **not** Swashbuckle.
- `builder.Services.AddOpenApi()` + `app.MapOpenApi()`.
- YAML: `app.MapOpenApi("/openapi/{documentName}.yaml")`.
- Enable `<GenerateDocumentationFile>true</GenerateDocumentationFile>` for XML comment → OpenAPI auto-population.
- `[ProducesResponseType<T>(200, Description = "...")]` — now accepts description.

### JSON Patch with System.Text.Json

```
dotnet add package Microsoft.AspNetCore.JsonPatch.SystemTextJson
```

~170x faster than Newtonsoft version. New package, not a drop-in replacement.

### Authentication

- **Cookie auth returns 401/403** for API endpoints (see Breaking Changes above).
- **Passkey/WebAuthn** built into ASP.NET Core Identity.
- **PAR** enabled by default for OIDC. Disable: `PushedAuthorizationBehavior.Disable`.
- `AdditionalAuthorizationParameters.Add("prompt", "login")` simplifies OAuth customization.

---

## ASP.NET Core 9 (Key Items)

- **`MapStaticAssets()`** — replaces `UseStaticFiles()`. Build-time compression, content-based ETags. Drop-in replacement.
- **`HybridCache`** — stampede protection, combines `IMemoryCache` + `IDistributedCache`. `cache.GetOrCreateAsync(key, async ct => await Expensive(...))`.
- **Keyed DI in middleware** — `[FromKeyedServices("name")]` works in middleware constructors.
- **`DisableHttpMetrics()`** — opt out per endpoint: `app.MapHealthChecks("/healthz").DisableHttpMetrics()`.

---

## Entity Framework Core 10

### `LeftJoin` / `RightJoin`

```csharp
// ❌ .NET 8 — manual GroupJoin + SelectMany + DefaultIfEmpty
var query = context.Students
    .GroupJoin(context.Departments,
        s => s.DepartmentId, d => d.Id,
        (s, deps) => new { s, deps })
    .SelectMany(x => x.deps.DefaultIfEmpty(),
        (x, d) => new { x.s.Name, Department = d.Name });

// ✅ .NET 10 — direct LeftJoin
var query = context.Students.LeftJoin(
    context.Departments,
    s => s.DepartmentId,
    d => d.Id,
    (s, d) => new { s.Name, Department = d.Name });
```

### Named query filters

```csharp
// ❌ .NET 8 — single unnamed filter, all-or-nothing ignore
modelBuilder.Entity<Post>().HasQueryFilter(p => !p.IsDeleted);
// Can only do: .IgnoreQueryFilters() — removes ALL filters

// ✅ .NET 10 — named, selectively disabled
modelBuilder.Entity<Post>().HasQueryFilter("SoftDelete", p => !p.IsDeleted);
modelBuilder.Entity<Post>().HasQueryFilter("TenantScope", p => p.TenantId == currentTenant);
// Disable just one:
context.Posts.IgnoreQueryFilters(["SoftDelete"]).ToListAsync();
```

### Other EF Core 10 features

| Feature | Notes |
|---------|-------|
| Vector search | `SqlVector<float>` + `EF.Functions.VectorDistance("cosine", col, vec)` for SQL Server 2025. |
| JSON data type | SQL Server 2025 uses native `json` (was `nvarchar(max)`). Pin with `.HasColumnType("nvarchar(max)")`. |
| Complex types | Now support optional types, structs, JSON via `ToJson()`, `ExecuteUpdateAsync` over JSON props. |
| Named default constraints | `HasDefaultValueSql("GETDATE()", "DF_Post_Created")` or `UseNamedDefaultConstraints()` globally. |
| Parameterized collections | Multiple scalar params by default (was JSON array). Configure: `UseParameterizedCollectionMode()`. |
| Security | Inlined constants redacted from logs. SQL injection analyzer warns on string concat in `FromSqlRaw`. |

### EF Core 10 Breaking Changes

- `ExecuteUpdateAsync` signature: `Func<>` not `Expression<Func<>>` (see above).
- JSON columns auto-migrate to `json` type on Azure SQL / SQL Server 2025.
- Complex type column names uniquified (appends number if duplicate).
- EF tools require `--framework` for multi-targeted projects.
- `Application Name` injected into connection strings by default.

### EF Core 9 (Key Items)

- **Complex types** introduced — `ComplexProperty()` for table splitting. Prefer over owned entities.
- **Precompiled models** — improved AOT/trimming support.

---

## .NET 10 Libraries (Code-Impacting)

| API | Notes |
|-----|-------|
| `System.Linq.AsyncEnumerable` | Now built-in. **Remove NuGet package** — conflicts. |
| `ReadOnlySet<T>` | New immutable set wrapper. |
| `WebSocketStream` | Wraps `WebSocket` in a `Stream`. |
| `PipeReader` in System.Text.Json | Better deserialization for large payloads. |
| JSON strict mode | Options for disallowing duplicate properties. |

### .NET 9 Libraries (Code-Impacting)

| API | Example |
|-----|---------|
| `CountBy` / `AggregateBy` | `items.CountBy(i => i.Category)` — no intermediate `GroupBy`. |
| `PriorityQueue.Remove()` | Update priority in-place. |
| `TimeSpan.FromSeconds(int)` | Int overload avoids `double` imprecision. |
| `CryptographicOperations.HashData()` | One-shot hash. |

---

## New Namespaces to Know

```csharp
using System.Threading;                  // Lock type (C# 13)
using Microsoft.Extensions.Validation;   // Validation APIs (shared package)
// System.Linq.AsyncEnumerable — built-in, remove NuGet reference
```

---

## Project Stack

The user builds:
- **Web APIs** — REST, GraphQL (HotChocolate), OpenAPI
- **Console apps** — Background services, jobs
- **Libraries**: Entity Framework Core, RabbitMQ, Confluent Kafka, Azure Auth, FluentValidation

---

## Search Heuristics

When you need information not in this file:

1. **Platform overview**: `https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-10/overview`
2. **ASP.NET Core**: `https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0`
3. **EF Core**: `https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew`
4. **C# 14**: `https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14`
5. **Breaking changes**: `https://learn.microsoft.com/en-us/dotnet/core/compatibility/10`
6. **.NET 9 overview**: `https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-9/overview`
7. **C# 13**: `https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-13`
