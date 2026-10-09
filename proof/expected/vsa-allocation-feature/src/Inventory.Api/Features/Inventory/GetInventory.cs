using Inventory.Api.Data;

namespace Inventory.Api.Features.Inventory;

internal static class GetInventory
{
    internal static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet(
            "/inventory/{sku}",
            (string sku, InventoryState state) =>
            {
                var item = Execute(sku, state);
                return item is null ? Results.NotFound() : Results.Ok(item);
            }
        );
    }

    internal static InventoryResponse? Execute(string sku, InventoryState state)
    {
        if (string.IsNullOrWhiteSpace(sku))
        {
            return null;
        }

        lock (state.SyncRoot)
        {
            if (!state.Stock.TryGetValue(sku.Trim(), out var locations))
            {
                return null;
            }

            var responseLocations = locations
                .Values.OrderBy(location => location.Location, StringComparer.Ordinal)
                .Select(location => new LocationInventoryResponse(
                    location.Location,
                    location.Available,
                    location.SafetyStock,
                    Math.Max(0, location.Available - location.SafetyStock)
                ))
                .ToArray();
            var available = responseLocations.Sum(location => (long)location.Allocatable);
            return new InventoryResponse(
                sku.Trim().ToUpperInvariant(),
                available,
                responseLocations
            );
        }
    }
}

internal sealed record InventoryResponse(
    string Sku,
    long Available,
    LocationInventoryResponse[] Locations
);

internal sealed record LocationInventoryResponse(
    string Location,
    int Available,
    int SafetyStock,
    int Allocatable
);
