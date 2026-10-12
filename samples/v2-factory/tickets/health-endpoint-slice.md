---
id: health-endpoint-slice
name: health-endpoint-slice
repository: git@github.com:Dazing/forge-test-repo.git
dependsOnTickets: []
baseBranch: main
---

# Move the health endpoint into its own slice

Kind: refactor

This is a small, behavior-preserving change to exercise Forge's commit, push, and draft pull-request workflow against `forge-test-repo`.

Move the existing `GET /health` endpoint from `src/src/Inventory.Api/Program.cs` into `src/src/Inventory.Api/Features/Health/GetHealth.cs`. Follow the existing slice convention: an internal static `GetHealth` class with an internal static `Map(IEndpointRouteBuilder app)` method. Register it from `Program.cs`, keeping that file composition-only.

Preserve the endpoint's existing response: HTTP `200` with JSON `{ "status": "ok" }`. Do not add dependencies, authentication, state access, readiness checks, or other endpoints. Follow `src/AGENTS.md` and update the repository README with the health endpoint and how to run the API locally.

## Acceptance criteria

- `GET /health` still returns HTTP `200` and JSON `{ "status": "ok" }`.
- The health route is defined in `Features/Health/GetHealth.cs`; `Program.cs` only registers the slice rather than defining its handler.
- Existing inventory and reservation behavior remains unchanged.
- From `src/`, `dotnet run --project tests/Inventory.Tests/Inventory.Tests.csproj` and `dotnet build src/Inventory.Api/Inventory.Api.csproj` pass.
- Start the API locally and verify `GET /health` with an HTTP request. Include the commands and observed results in the pull-request description.
- The README documents the health endpoint and a working local API launch command.

## Workflow verification

Let Forge perform the commit, push, and draft pull-request creation; do not publish manually. The runner's completion annotation should record the retained workspace, ticket branch, final commit SHA, and draft PR URL. The draft PR should target `main` and contain only this refactor and its directly related documentation and verification changes.
