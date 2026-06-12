# 0009 — Golden-path stack: .NET API + React front, as a monorepo

**Status:** Accepted

## Context

Review depth is the whole point of the loop, and review depth tracks the owner's
expertise. The portfolio skews toward engine/integration-shaped products. A scattershot
stack choice per product would dilute both expertise and tooling reuse.

## Decision

The golden path is an **ASP.NET Core API + React (Vite) front in one monorepo**:
`api/` + `web/` + one devcontainer + one compose file → one clone, one CI, one deployable
unit per product. Chosen for maximum review depth (deepest expertise) and fit for
engine/integration-shaped products.

Full-stack TypeScript remains a **documented escape hatch** when a product is plainly
CRUD-web-shaped.

## Consequences

- The template ships this exact shape (`api/` .NET 10 + `web/` React/Vite/TS + compose).
- One CI and one deployable per product simplifies promotion (see ADR 0010).
- A genuinely CRUD-web product may take the TS escape hatch rather than force the API.
