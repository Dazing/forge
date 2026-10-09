# C# 12 — Version-Gated Guidance

**Minimum supported pairing:** C# 12 with .NET 8. Use only when the effective
project language version is at least 12.

Prefer features because they clarify code, not because they are newer.

## Collection expressions

Collection expressions are target-typed and can create arrays, spans, lists, and
other collection-builder-enabled types. Prefer them over constructor/initializer
boilerplate when the target type is obvious.

Avoid:

```csharp
int[] retries = new[] { 1, 2, 3 };
List<string> names = new() { "Ada", "Grace" };
```

Prefer:

```csharp
int[] retries = [1, 2, 3];
List<string> names = ["Ada", "Grace"];
```

Use spread elements for clear composition:

```csharp
string[] allNames = [.. primaryNames, .. fallbackNames];
```

Rules:

- Supply a target type; `var values = [1, 2, 3]` has no target type.
- Remember that spread elements enumerate their source.
- Keep the older syntax when overload resolution, type inference, or builder
  behavior would be less obvious.

## Primary constructors for classes and structs

Use a primary constructor when a short type stores or directly uses a small set
of construction dependencies.

```csharp
public sealed class OrderReader(IOrderStore store)
{
    public Task<Order?> FindAsync(Guid id, CancellationToken cancellationToken) =>
        store.FindAsync(id, cancellationToken);
}
```

Important:

- Unlike record parameters, class/struct primary-constructor parameters do not
  become properties.
- A parameter is in scope throughout the type and is captured only when needed.
- Do not both capture a parameter and copy it into another field/property without
  understanding the duplicate storage.
- Prefer an ordinary constructor when validation, multiple construction paths,
  debugger visibility, or explicit initialization order is clearer.
- Do not use primary constructors to compress a large class or hide excessive
  dependencies.

## Default lambda parameters

Lambdas can declare optional parameters. Use this for local callback APIs where
an optional value is genuinely part of the delegate contract.

```csharp
var scale = (decimal value, decimal factor = 1m) => value * factor;
```

Prefer a named method for public contracts, reuse, XML documentation, or complex
behavior. Ensure the target delegate's parameter defaults are compatible.

## Alias any type

A `using` alias can name tuples, arrays, pointers, and other types:

```csharp
using Point = (double X, double Y);
```

Use aliases to improve local readability at interop or tuple-heavy boundaries.
An alias does not create a distinct type or stronger domain invariant; create a
real type when type safety matters.

## `ref readonly` parameters

Use `ref readonly` in low-level API design when the argument must be a variable,
must not be mutated, and copying is meaningfully costly. Do not apply it to small
values or ordinary application methods: the calling constraints and cognitive
cost usually outweigh speculative savings.

## Inline arrays

`[InlineArray]` provides fixed-size inline storage in a struct. It is primarily a
runtime, interop, and performance-library tool. Introduce it only with measured
need and careful default-value, bounds, and ref-safety review. Ordinary
application code should use arrays, spans, or existing collection types.

## `ExperimentalAttribute`

Mark intentionally experimental APIs with `ExperimentalAttribute` so consumers
receive compiler diagnostics. Do not use the attribute as a substitute for a
stable contract or to normalize experimental dependencies in production code.

## Interceptors remain preview

Interceptors were exposed as a C# 12 preview facility for source generators.
Do not introduce them into stable application or library code unless the user
explicitly requests preview features and accepts the compatibility risk.

## Primary source

- https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-12
