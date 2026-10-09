---
name: csharp
description: >-
  Prescriptive baseline for writing, modifying, debugging, or reviewing C# code
  in any project. Load as soon as work may contribute C# code. Covers readable
  modern C# practices, nullability, async, collections, errors, dependency
  injection, structured logging, and version-gated C# 12-14 features. Project
  instructions and established repository conventions always take precedence.
---

# Modern C# Baseline (C# 12-14)

Use this skill for every C# contribution, even when the project targets an older
language version. The baseline practices still apply; newer syntax does not.

## Precedence and scope

Apply guidance in this order:

1. The user's instructions and repository-local rules.
2. The project's effective compiler settings, analyzers, `.editorconfig`, and
   established conventions.
3. This skill's defaults where the project is silent.

Do not impose this skill's style on an established codebase. Do not change a
TFM, `LangVersion`, nullable setting, analyzer configuration, public contract,
or dependency merely to use a preferred pattern.

This skill covers language and implementation practices plus framework-neutral
DI, logging, and error handling. Architecture, framework-specific conventions,
and testing are out of scope; load the relevant project skill for those.

## Establish the capability boundary first

Before using version-specific syntax, inspect the nearest `*.csproj`, inherited
`Directory.Build.props` / `Directory.Build.targets`, and `global.json` when
present.

| Language feature level | Default associated TFM |
|---|---|
| C# 12 | .NET 8 |
| C# 13 | .NET 9 |
| C# 14 | .NET 10 |

An explicit `LangVersion` can restrict the compiler further. Do not set
`LangVersion` to `latest` or enable `preview`; those make builds
environment-dependent. Microsoft does not support a language version newer than
the one associated with the target TFM. If the effective version remains uncertain,
use syntax already established in the project or verify with the compiler.
Never guess that a post-training API or syntax exists; consult current Microsoft
documentation when uncertain.

## Mandatory defaults

### Clarity

- Write the smallest direct implementation that makes invariants and failure
  paths obvious. Prefer meaningful names and ordinary control flow over dense
  expressions, clever pattern matching, or long fluent chains.
- Match repository naming and layout. Where silent, use standard .NET naming;
  use `var` when the type is evident from the expression and an explicit type
  when it improves scanning.
- Prefer immutable state where practical. Use records for value/data semantics,
  classes for identity or behavior, and structs only for small value-like types.
- Keep visibility as narrow as the use case permits. Do not add abstractions,
  interfaces, extension methods, or generic helpers for a single speculative use.
- Comments explain constraints and reasons, not what the syntax already says.

### Formatting

- After the final C# edit and before build or test verification, format only the
  changed `.cs` files. Use the repository's established formatter command when
  one exists. If the repository pins CSharpier as a local dotnet tool, run
  `dotnet csharpier format <changed-files>`; otherwise, when the global tool is
  available, run `csharpier format <changed-files>`.
- Do not format the entire repository unless the task is explicitly repository-wide.
  Do not use `--skip-validation`, ignore formatter failures, or manually undo
  formatter output to preserve a preferred layout.

### Contracts and nullability

- Treat nullable annotations as API contracts. Model absence with `?`; keep
  required values non-nullable and valid after construction.
- Fix nullable warnings at the source. Do not use `!`, dummy defaults, or broad
  warning suppression to silence uncertainty.
- Validate untrusted or public-boundary input with specific guards. Do not
  duplicate checks where the type system or an upstream boundary guarantees the
  invariant.

### Async and resources

- Await I/O asynchronously end to end. Never block a task with `.Result`,
  `.Wait()`, or `.GetAwaiter().GetResult()` in ordinary application code.
- Return `Task` / `Task<T>`; reserve `async void` for event handlers. Accept and
  propagate `CancellationToken` when the operation can meaningfully cancel.
- Do not wrap naturally asynchronous I/O in `Task.Run`. Use `Task.Run` for
  measured CPU-bound work only at a responsiveness or concurrency boundary.
- Use `using` / `await using` for owned resources. Do not dispose dependencies
  whose lifetime is owned by a DI container.

### Collections and execution

- Choose a collection shape that expresses use: enumeration, indexed read,
  mutation, or keyed lookup. Do not expose a mutable concrete collection without
  intending callers to mutate it.
- Prefer readable LINQ for transformations. Use direct loops when state,
  short-circuiting, side effects, or complex async flow makes LINQ obscure.
- Remember deferred execution. Avoid accidental multiple enumeration and
  materialize once at the boundary that requires a snapshot.
- Do not introduce spans, pooling, custom builders, `ValueTask`, or similar
  complexity without a demonstrated requirement.

### Errors, DI, and logging

- Use exceptions for exceptional failures, not routine branching. Catch only
  when the code can recover, translate at a boundary, add actionable context, or
  restore invariants. Preserve stack traces with `throw;`.
- Do not invent a `Result` abstraction when the project has no such convention.
- Prefer constructor injection. Avoid service location, static service access,
  and `BuildServiceProvider()` during registration. Choose lifetimes deliberately;
  singletons and their captured dependencies must be safe for concurrent use.
- Use structured logging templates with named properties. Never interpolate log
  messages, log secrets, or both log and rethrow the same failure at every layer.
- Prefer ordinary `ILogger` calls for clarity. Use source-generated logging when
  the repository already does or when repeated/hot logging justifies the extra
  declaration.

## Reference routing

Read only the files relevant to the change:

- General implementation, nullability, async, collections, errors, DI, logging:
  [`practices.md`](practices.md)
- C# 12 syntax or modernization: [`csharp-12.md`](csharp-12.md)
- C# 13 syntax or modernization: [`csharp-13.md`](csharp-13.md)
- C# 14 syntax or modernization: [`csharp-14.md`](csharp-14.md)

When reviewing older code, recommend modernization only if it improves clarity
and the effective language version supports it. Do not churn correct code solely
to demonstrate new syntax.
