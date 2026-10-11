# C# 13 — Version-Gated Guidance

**Minimum supported pairing:** C# 13 with .NET 9. Use only when the effective
project language version is at least 13. Some features also require .NET 9 BCL
types, as noted.

## `params` collections

`params` can target spans and supported collection types, not only arrays.

```csharp
public static string JoinLines(params ReadOnlySpan<string> lines) =>
    string.Join(Environment.NewLine, lines);
```

Use a non-array `params` type when it makes the API clearer or a demonstrated
call path benefits from its allocation behavior. Do not replace every
`params T[]`: arrays remain familiar, storable, and broadly compatible. A span
parameter must not escape the call.

## `System.Threading.Lock`

**Requires .NET 9.** For new synchronous mutual exclusion, prefer the dedicated
`Lock` type over locking on a plain `object`:

```csharp
private readonly Lock _gate = new();

public void Update()
{
    lock (_gate)
    {
        // Synchronous protected state change.
    }
}
```

Never lock on `this`, a type object, a string, or another publicly reachable
object. Keep critical sections small and never `await` inside `lock`.

## Escape character

Use `\e` for Unicode U+001B rather than `\x1b`; the latter can consume following
hexadecimal characters unexpectedly.

```csharp
const char Escape = '\e';
```

## Safer ref-like composition

C# 13 allows:

- `ref` locals and `ref struct` locals in async methods and iterators, provided
  they do not cross an `await` or `yield` boundary;
- `ref struct` types to implement interfaces, without boxing conversion; and
- generic parameters with `where T : allows ref struct`.

These are advanced library/performance tools. Use them only where stack-only
semantics are part of the design. Let compiler ref-safety diagnostics stand; do
not work around them with unsafe code merely to retain a reference across a
suspension point.

## Partial properties and indexers

Partial properties and indexers let source generators split a defining
declaration from its implementation. Prefer them for generator/tooling scenarios,
not as a way to scatter hand-written behavior across files. The implementing
partial property cannot be an auto-property.

## Overload resolution priority

`OverloadResolutionPriorityAttribute` helps library authors add a preferred
overload without immediate ambiguity. Use it only for compatibility-sensitive
API evolution after reviewing all overloads and consumers. It is not a general
replacement for a clear overload set.

## Mostly automatic or niche changes

- Method-group natural-type improvements generally require no source change.
- Implicit `^` index access in object initializers is useful only when it makes a
  fixed-size initialization clearer than direct assignment.
- `unsafe` contexts are allowed in iterators, but every `yield` must remain in a
  safe context. Do not introduce unsafe code without a concrete need and review.

## Do not treat `field` as stable C# 13

The `field` contextual keyword was preview in C# 13. Do not use it in stable
C# 13 code. It became a released feature in C# 14; follow
[`csharp-14.md`](csharp-14.md) when the project supports C# 14.

## Primary source

- https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-13
