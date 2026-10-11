---
name: vertical-slice-architecture
description: >-
  Design, implement, review, or enforce an explicitly adopted vertical-slice
  architecture. Use when the user requests VSA, the repository already follows
  VSA, or the task concerns slice boundaries, capability granularity, feature
  ownership, composition roots, or VSA enforcement. Supports .NET APIs/jobs and
  TypeScript web/API applications, and Go HTTP/worker applications. Do not use
  solely because a task involves C#, .NET, TypeScript, Go, React, an endpoint,
  a job, or a feature.
---

# Vertical Slice Architecture

This skill applies to an explicit architectural choice, not to a programming
language. Load it only when VSA is requested, already established in the
repository, or directly relevant to the task.

## Shared model

VSA organizes code around capabilities rather than technical layers. A slice is
one user capability, kept small enough to read top-to-bottom and with a
countable dependency surface.

Use these four buckets:

| Bucket | Responsibility | Boundary |
|---|---|---|
| **Slice** | One capability's entry point, logic, data mapping, and behavioral test | Self-contained; do not reference another slice directly |
| **Feature** | Owns a domain's state/data and groups related slices | Exposes only the platform-specific public surface |
| **Composition root** | Arranges slices, routing, layout, and host startup | Nesting and wiring live here, never in slices |
| **Shared** | Stateless infrastructure, pure utilities, and platform plumbing | No feature-specific business logic or state ownership |

### Granularity gate

> If you cannot write a meaningful failing test for it, it is not a slice; it
> is a helper or implementation detail.

Do not create technical-layer slices or split trivial mappings into capabilities.
Start with the platform's normal feature grouping and split only when navigation
or ownership becomes genuinely difficult.

### Boundary enforcement

Make boundaries mechanical where practical. Use the platform-specific enforcement
example after selecting the platform and host dialect. Work slice by slice,
test-first when introducing behavior; the `tdd` skill owns the general cycle and
evidence rules.

## Select platform and dialect

Read only the references needed for the package being changed:

| Project signals | Read |
|---|---|
| .NET API / ASP.NET host | `platforms/dotnet/core.md` and `platforms/dotnet/api.md` |
| .NET worker / background jobs | `platforms/dotnet/core.md` and `platforms/dotnet/jobs.md` |
| TypeScript React/web app | `platforms/typescript/core.md` and `platforms/typescript/web.md` |
| TypeScript HTTP API | `platforms/typescript/core.md` and `platforms/typescript/api.md` |
| Go HTTP API (net/http) | `platforms/go/core.md` and `platforms/go/api.md` |
| Go worker / CLI job | `platforms/go/core.md` and `platforms/go/jobs.md` |
| Mixed repository | Select references independently for each package; do not load unrelated dialects |

For enforcement, use the matching example under `enforcement/dotnet/`,
`enforcement/typescript/`, or `enforcement/go/`. A .NET change also loads
`csharp` and `dotnet-10`; a behavioral implementation may also load `tdd`.

## What this skill does not imply

Do not infer VSA from the presence of a feature folder, endpoint, job, React,
TypeScript, C#, Go, or .NET. Do not impose these conventions on a repository
that has not adopted them. Follow repository-local architecture when it
conflicts with this skill.
