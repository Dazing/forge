# Inventory allocation API agent instructions

- Target .NET 10 with nullable reference types enabled and warnings treated as errors.
- Keep each HTTP capability under `Features/Inventory` or `Features/Reservations`; the implemented reallocation capability owns `Features/Reservations/ReallocateReservation/` because it combines an endpoint, calculator, external client, and boundary DTOs.
- A slice may use `Data` and ASP.NET Core but must not reference another slice. Keep operation methods and calculation types internal and expose internals only to `Inventory.Tests`.
- Keep `Program.cs` composition-only. `Data` owns synchronization and persistence-shaped records only; it must not contain routing, allocation, quantity, transition, or HTTP policy.
- Do not add controllers, services, repositories, MediatR, AutoMapper, reflection discovery, external persistence, retry behavior, compatibility shims, or package dependencies.
- Preserve case-insensitive SKU and location identity and uppercase public representations.
- Never hold the `InventoryState` lock across outbound HTTP. Snapshot under the lock, release it for HTTP and calculation, then compare and commit under the lock.
- Hold the single `InventoryState` lock across every stock/reservation multi-value mutation. Failed operations are mutation-free, and every successful write increments the state version exactly once unless it is a successful no-op.
- Keep external routing DTOs out of `Data` and public responses; keep persistence records out of public HTTP responses.
- Preserve the completed reallocation contract: explicit boundary mappings, routing priority, safety stock, optimistic version/snapshot comparison, atomic commit, timeout/error mapping, and unchanged-decision no-op behavior.
- Use test-first changes. Run `dotnet run --project tests/Inventory.Tests/Inventory.Tests.csproj` and `dotnet build src/Inventory.Api/Inventory.Api.csproj`.
- Outside this checkout, read only supplied standards and acceptance suites under `/factory-inputs/`. Never modify those inputs or access other external files.
