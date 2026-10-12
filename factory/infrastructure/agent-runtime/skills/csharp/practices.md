# General C# Practices

These are fallback prescriptions. Repository rules and established local
patterns override them.

## Readability and type design

- Give each method one describable job. Extract only when the new name clarifies
  intent, removes real duplication, or isolates a policy.
- Prefer guard clauses when they remove nesting; keep related success logic
  together when early returns would fragment it.
- Use switch expressions for compact value selection. Use a switch statement
  when arms require multiple operations, logging, or distinct failure handling.
- Use language keywords (`string`, `int`, `bool`) rather than CLR aliases in
  ordinary C# source unless the repository says otherwise.
- Prefer explicit invariants over partially initialized objects. Constructors
  fit required behavioral dependencies; `required init` members fit data shapes
  assembled with object initializers.
- Use records only when value equality is intended. Do not turn mutable entities
  or identity-bearing services into records for terser syntax.
- Avoid boolean parameters whose meaning is unclear at the call site. Prefer a
  small enum or separate named operation when it makes the contract clearer.

## Nullability

Nullable reference types describe intent; they do not add runtime checks.

- `T` means callers and implementations must provide a value; `T?` means absence
  is a supported state that code must handle.
- Use flow analysis (`is null`, `is not null`, property patterns, guard clauses)
  before reaching for nullable attributes.
- Use attributes such as `NotNullWhen`, `MemberNotNull`, or `NotNullIfNotNull`
  only when a real API relationship cannot be expressed by annotations alone.
- Use `ArgumentNullException.ThrowIfNull(value)` at a public or untrusted boundary
  when null violates the runtime contract.
- Use the null-forgiving operator only when an external invariant is real,
  documented nearby, and cannot be expressed to the compiler. It is not a fix
  for a warning.

Avoid:

```csharp
return customer!.Address!.City;
```

Prefer an explicit contract or absence path:

```csharp
ArgumentNullException.ThrowIfNull(customer);
return customer.Address?.City;
```

## Async and concurrency

- I/O-bound work: call the asynchronous API and `await` it. Do not use
  `Task.Run` to make blocking I/O look asynchronous.
- CPU-bound work: keep the core computation synchronous; move it with
  `Task.Run` only where responsiveness or parallel scheduling is actually needed.
- Pass `CancellationToken` to downstream operations. Cancellation is cooperative;
  do not claim cancellation after irreversible work has completed.
- Catch `OperationCanceledException` rather than `TaskCanceledException` when
  cancellation needs distinct handling. Do not report expected cancellation as
  an error.
- Start independent operations before `Task.WhenAll`; do not add concurrency
  where ordering, rate limits, or shared state require serialization.
- Avoid fire-and-forget tasks. If ownership truly leaves the caller, hand work to
  an existing durable/background mechanism and define error observation.
- Avoid `async void` except event handlers. A task-returning method makes
  completion and exceptions observable.
- Use `ValueTask` only when an API is proven allocation-sensitive and frequently
  completes synchronously; it has stricter consumption rules than `Task`.

Avoid:

```csharp
var profile = GetProfileAsync(id).Result;
```

Prefer:

```csharp
var profile = await GetProfileAsync(id, cancellationToken);
```

Do not add `ConfigureAwait(false)` mechanically. Follow the host or library's
established convention and use it only when its continuation behavior is
understood.

## Collections and LINQ

- Accept the weakest contract the implementation needs: `IEnumerable<T>` for one
  pass, `IReadOnlyCollection<T>` for count, `IReadOnlyList<T>` for indexed reads.
  Do not weaken a contract if repeated enumeration would be unsafe.
- Return a read-only view or snapshot when callers must not mutate internal
  storage. An interface alone does not make the underlying object immutable.
- Use `Any()` for an `IEnumerable<T>` existence check. Use `Count` / `Length`
  directly when the concrete shape exposes it.
- Keep LINQ selectors and predicates pure. A loop is clearer for side effects,
  mutation, complex branching, or per-item exception handling.
- Materialize at deliberate ownership boundaries, not between every operator.
- Avoid repeated enumeration of a potentially remote, stateful, expensive, or
  single-use sequence.

## Error handling and resource ownership

- Validate routine invalid input before an operation when doing so is race-safe.
  Prefer established `Try*` APIs for expected parse or lookup failure.
- Throw the most specific standard exception that describes a contract failure.
  Create a custom exception only when callers need a distinct semantic failure.
- Catch from most specific to least specific. Do not catch `Exception` unless at
  a true boundary or when cleanup/rollback is followed by an immediate rethrow.
- Preserve the original exception as `InnerException` when translating it.
- Keep state consistent if an operation fails; perform work transactionally or
  roll back before rethrowing.
- Use `using` / `await using` rather than a `try/finally` whose only purpose is
  disposal.

Avoid resetting the stack trace:

```csharp
catch (Exception exception)
{
    throw exception;
}
```

Prefer:

```csharp
catch
{
    // Restore an invariant here when necessary.
    throw;
}
```

## Dependency injection

- Use constructor injection for required collaborators. An optional dependency
  should represent a genuinely optional capability, not hide incomplete setup.
- Depend on an interface or delegate when it represents a stable boundary or
  real substitution point. Do not create one interface per class by reflex.
- Keep construction synchronous. Perform asynchronous initialization through an
  explicit lifecycle method or the host's startup mechanism.
- Do not inject `IServiceProvider` merely to resolve ordinary dependencies. Do
  not store a global/static provider.
- Do not call `BuildServiceProvider()` while registering services. Use the
  registration overload that receives `IServiceProvider` when a factory needs
  dependencies.
- Choose the shortest lifetime consistent with ownership and sharing. A singleton
  must be thread-safe and must not capture scoped services.
- The container disposes instances it creates. Code consuming a container-owned
  `IDisposable` or `IAsyncDisposable` must not dispose it.
- Create and dispose an explicit scope for scoped work initiated outside an
  existing scope.

Avoid service location:

```csharp
public sealed class InvoiceService(IServiceProvider services)
{
    public Task SendAsync() =>
        services.GetRequiredService<IInvoiceSender>().SendAsync();
}
```

Prefer an explicit dependency:

```csharp
public sealed class InvoiceService(IInvoiceSender sender)
{
    public Task SendAsync() => sender.SendAsync();
}
```

## Logging

- Inject `ILogger<TCategory>` when one type emits the logs. Use `ILoggerFactory`
  when a public component must create loggers for multiple internal categories.
- Write stable event messages and named properties. Property names are part of
  the operational query surface; use meaningful domain names rather than
  positional placeholders.
- Pass exceptions through the logging API's exception parameter so providers
  retain exception details.
- Match level to actionability: `Trace`/`Debug` diagnostics, `Information`
  meaningful normal events, `Warning` recoverable abnormal conditions, `Error`
  failed operations, `Critical` process- or system-threatening failures.
- Avoid logging the same exception at every layer. Log where it is handled or at
  the boundary that owns the operation.
- Never log credentials, tokens, secrets, or unnecessary personal data. Treat
  object destructuring and `ToString()` as possible data disclosure.
- Guard genuinely expensive log argument creation with `IsEnabled`; do not add
  guards around cheap structured arguments.

Avoid interpolation:

```csharp
logger.LogInformation($"Processed order {orderId} for {customerId}");
```

Prefer a structured template:

```csharp
logger.LogInformation(
    "Processed order {OrderId} for customer {CustomerId}",
    orderId,
    customerId);
```

Source-generated `[LoggerMessage]` methods improve typing and hot-path cost, but
add declarations. Prefer them when the project already uses them, log sites are
repeated, or measurement justifies them; otherwise keep the direct structured
call.

## Performance restraint

Readable code is the default optimization. Before adding pooling, spans, unsafe
code, manual vectorization, custom caching, or allocation-avoidance machinery:

1. identify a concrete workload or requirement;
2. measure the relevant path;
3. choose the smallest change that addresses the measured bottleneck; and
4. preserve a clear ownership and lifetime model.

Do not trade away clarity for speculative savings.

## Primary sources

- https://learn.microsoft.com/dotnet/csharp/fundamentals/coding-style/coding-conventions
- https://learn.microsoft.com/dotnet/csharp/fundamentals/null-safety/nullable-reference-types
- https://learn.microsoft.com/dotnet/csharp/asynchronous-programming/async-scenarios
- https://learn.microsoft.com/dotnet/standard/exceptions/best-practices-for-exceptions
- https://learn.microsoft.com/dotnet/core/extensions/dependency-injection/guidelines
- https://learn.microsoft.com/dotnet/core/extensions/logging/overview
- https://learn.microsoft.com/dotnet/core/extensions/logging/library-guidance
