# <product-name>

A product built with [forge](https://github.com/dazing/forge) — `.NET` API + React
web in one monorepo.

## Layout

```
api/    ASP.NET Core minimal API (.NET 10) + xUnit tests   (solution: api/Forge.slnx)
web/    React + Vite + TypeScript                          (dev proxies /api → api)
docs/   adr/ (decisions) · briefs/ (units of work)
docker-compose.yml   api + web + postgres for local full-stack runs
```

## Run it

API:

```bash
cd api
dotnet run --project Forge.Api      # http://localhost:5283/api/health
```

Web (separate terminal):

```bash
cd web
npm install
npm run dev                          # http://localhost:5173 — fetches /api/health
```

Or the whole stack:

```bash
docker compose up
```

## Test / build

```bash
cd api && dotnet test       # xUnit
cd web && npm run build     # tsc + vite build
```

## How we work here

This repo runs the **forge loop**. See [`CLAUDE.md`](./CLAUDE.md) for the loop, the
sizing scheme, and the implementation rules. In short, each unit of work is:

`/forge:start` → `/forge:grill` (gate 1: approve the brief) → implement → review
(gate 2: merge the PR) → `/forge:compound`.

## Sandbox

This repo requires sessions to run inside a **credential-free sandbox**
(`.forge.json` → `"sandbox": "required"`; forge ADR 0013/0016). Start every session
inside an approved boundary — Docker Sandboxes or the hardened fallback devcontainer.
See [`SANDBOX.md`](./SANDBOX.md) for the per-host-class setup, the egress allowlist,
and the scoped-PAT guide. The forge plugin warns loudly if you start on the bare host.
