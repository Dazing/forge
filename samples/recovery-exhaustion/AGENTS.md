# Inventory API agent instructions

- Target .NET 10 and keep nullable reference types enabled.
- Organize each capability by business behavior; do not introduce infrastructure layers for the in-memory POC.
- Use test-first changes. Run `dotnet run --project tests/Inventory.Tests/Inventory.Tests.csproj` and `dotnet build src/Inventory.Api/Inventory.Api.csproj`.
- Preserve the public HTTP contract and return explicit 4xx responses for invalid requests or transitions.
- Keep stock mutations atomic and enforce `available >= 0` and `reserved >= 0`.
- Outside this checkout, read only the supplied standards and acceptance suite under `/factory-inputs/`. Never modify those inputs or access other external files.
