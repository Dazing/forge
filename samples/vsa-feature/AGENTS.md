# Inventory API agent instructions

- Target .NET 10 with nullable reference types enabled and warnings treated as errors.
- Add each HTTP capability as one file under `Features/Inventory` or `Features/Reservations`; a slice may use `Data` and ASP.NET Core but must not reference another slice.
- Keep `Program.cs` composition-only. `Data` owns synchronization and persistence-shaped records only; it must not contain quantity or transition policy.
- Do not add controllers, services, repositories, MediatR, external persistence, package dependencies, or feature-discovery infrastructure.
- Preserve case-insensitive SKU identity and uppercase SKU responses.
- Hold the single `InventoryState` lock across every stock/reservation multi-value mutation.
- Keep operation methods internal and expose internals only to `Inventory.Tests`.
- Use test-first changes. Run `dotnet run --project tests/Inventory.Tests/Inventory.Tests.csproj` and `dotnet build src/Inventory.Api/Inventory.Api.csproj`.
- Read relevant supplied skills from Pi's read-only global skills directory at `~/.pi/agent/skills/`, including companion files referenced by each skill. Do not modify those skills or access files outside this checkout except that directory.
