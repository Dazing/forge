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
        lock (state.SyncRoot)
        {
            return state.Stock.TryGetValue(sku, out var available)
                ? new InventoryResponse(sku.ToUpperInvariant(), available)
                : null;
        }
    }
}

internal sealed record InventoryResponse(string Sku, int Available);
