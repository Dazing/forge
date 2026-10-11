# C# 14 — Version-Gated Guidance

**Minimum supported pairing:** C# 14 with .NET 10. C# 14 is the latest stable
release covered by this skill. Do not use C# 15 or preview features unless the
user and project explicitly opt in.

## Field-backed properties

Use the contextual `field` keyword when a property needs simple accessor logic
but no separately named backing field.

Avoid boilerplate:

```csharp
private string _name = "";
public string Name
{
    get => _name;
    set => _name = value ?? throw new ArgumentNullException(nameof(value));
}
```

Prefer:

```csharp
public string Name
{
    get;
    set => field = value ?? throw new ArgumentNullException(nameof(value));
}
```

Keep an explicit field when other members need field-level access, attributes,
`ref` access, or a distinct name that clarifies the invariant. In a type that
already declares an identifier named `field`, rename it when practical or use
`@field` / `this.field` deliberately to disambiguate.

## Null-conditional assignment

Use `?.` or `?[]` on the left side when the exact intent is “assign only when the
receiver exists.” The right side is not evaluated when the receiver is null.

```csharp
subscription?.LastSeenAt = clock.GetUtcNow();
handlers?[eventName] += handler;
```

Prefer an explicit `if` when the null case needs logging, fallback behavior,
multiple operations, or explanation. `++` and `--` are not supported through
null-conditional assignment.

## Extension members

Extension blocks can define instance extension methods and properties plus
static extension members and operators.

```csharp
public static class SequenceExtensions
{
    extension<T>(IEnumerable<T> source)
    {
        public bool IsEmpty => !source.Any();
    }
}
```

Use an extension block when related extension members form a coherent surface or
when an extension property/static member is the clearest API. A traditional
`this` extension method remains valid and is often clearer for one method. Do
not use extensions to conceal ownership, simulate mutable state, or override an
existing member: real instance/static members always win binding.

## First-class span conversions

C# 14 improves implicit conversions and generic/extension binding among arrays,
`Span<T>`, and `ReadOnlySpan<T>`. This makes existing span-oriented APIs easier
to call; it is not a reason to convert ordinary application APIs to spans.

Use spans for synchronous, nonescaping access to contiguous memory when a real
allocation or slicing requirement exists. Recheck overload resolution when
adding span overloads because the new conversions can change which candidate is
applicable.

## `nameof` with unbound generics

Prefer the actual generic type when its name is required:

```csharp
var category = nameof(Dictionary<,>); // "Dictionary"
```

This replaces dummy closed types such as `nameof(Dictionary<object, object>)`.

## Lambda parameter modifiers without repeated types

Simple lambda parameters can use `ref`, `in`, `out`, `scoped`, or `ref readonly`
without spelling every parameter type:

```csharp
delegate bool Parser<T>(string text, out T value);
Parser<int> parse = (text, out value) => int.TryParse(text, out value);
```

Use this when modifiers are required and inference stays obvious. `params` still
requires explicit parameter types.

## Partial constructors and events

Partial instance constructors and events extend source-generator integration.
Use them where generated and hand-written declarations genuinely share a type;
do not split ordinary hand-written behavior without a tooling need. Each member
requires one defining and one implementing declaration. Only the implementing
constructor can use `this()` or `base()`; an implementing event supplies `add`
and `remove` accessors.

## User-defined compound assignment

Types can define compound-assignment operators directly. Use them only for
value-like or numeric abstractions where mutation/assignment semantics are
unsurprising and consistent with the corresponding binary operation. Ordinary
business types should prefer named methods.

## File-based apps

The .NET 10 SDK can build and run a single `.cs` file with `dotnet file.cs`.
C# 14 file-based app directives such as `#:package` can declare build inputs in
that file. Use this for small utilities, learning, and focused prototypes. Move
to a project file when the program needs multiple source files, centralized
build policy, substantial dependency management, packaging, or long-term team
maintenance.

## Primary sources

- https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-14
- https://learn.microsoft.com/dotnet/csharp/programming-guide/classes-and-structs/extension-methods
- https://learn.microsoft.com/dotnet/csharp/fundamentals/tutorials/file-based-programs
