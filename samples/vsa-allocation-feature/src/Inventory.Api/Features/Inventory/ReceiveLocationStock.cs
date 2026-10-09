using Inventory.Api.Data;

namespace Inventory.Api.Features.Inventory;

internal static class ReceiveLocationStock
{
    internal static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost(
            "/inventory/{sku}/locations/{location}/receipts",
            (
                string sku,
                string location,
                ReceiveLocationStockRequest request,
                InventoryState state
            ) =>
            {
                var result = Execute(sku, location, request.Quantity, state);
                return result.Outcome switch
                {
                    ReceiveLocationStockOutcome.Received => Results.Ok(result.Item),
                    ReceiveLocationStockOutcome.Invalid => Results.ValidationProblem(
                        new Dictionary<string, string[]>
                        {
                            [
                                string.IsNullOrWhiteSpace(sku) ? "sku"
                                : string.IsNullOrWhiteSpace(location) ? "location"
                                : "quantity"
                            ] =
                            [
                                "SKU and location must not be blank and quantity must be positive.",
                            ],
                        }
                    ),
                    ReceiveLocationStockOutcome.Overflow => Results.Conflict(),
                    _ => throw new InvalidOperationException("Unknown receipt outcome."),
                };
            }
        );
    }

    internal static ReceiveLocationStockResult Execute(
        string sku,
        string location,
        int quantity,
        InventoryState state
    )
    {
        if (string.IsNullOrWhiteSpace(sku) || string.IsNullOrWhiteSpace(location) || quantity <= 0)
        {
            return new ReceiveLocationStockResult(ReceiveLocationStockOutcome.Invalid, null);
        }

        var normalizedSku = sku.Trim().ToUpperInvariant();
        var normalizedLocation = location.Trim().ToUpperInvariant();
        lock (state.SyncRoot)
        {
            if (!state.Stock.TryGetValue(normalizedSku, out var locations))
            {
                locations = new Dictionary<string, LocationStockRecord>(
                    StringComparer.OrdinalIgnoreCase
                );
            }

            locations.TryGetValue(normalizedLocation, out var current);
            var available = current?.Available ?? 0;
            if (available > int.MaxValue - quantity)
            {
                return new ReceiveLocationStockResult(ReceiveLocationStockOutcome.Overflow, null);
            }

            var updated = new LocationStockRecord(
                normalizedSku,
                normalizedLocation,
                available + quantity,
                current?.SafetyStock ?? 0
            );
            if (!state.Stock.ContainsKey(normalizedSku))
            {
                state.Stock.Add(normalizedSku, locations);
            }
            locations[normalizedLocation] = updated;
            state.Version++;
            return new ReceiveLocationStockResult(
                ReceiveLocationStockOutcome.Received,
                new ReceiveLocationStockResponse(
                    updated.Sku,
                    updated.Location,
                    updated.Available,
                    updated.SafetyStock,
                    updated.Available - updated.SafetyStock
                )
            );
        }
    }
}

internal sealed record ReceiveLocationStockRequest(int Quantity);

internal sealed record ReceiveLocationStockResult(
    ReceiveLocationStockOutcome Outcome,
    ReceiveLocationStockResponse? Item
);

internal sealed record ReceiveLocationStockResponse(
    string Sku,
    string Location,
    int Available,
    int SafetyStock,
    int Allocatable
);

internal enum ReceiveLocationStockOutcome
{
    Received,
    Invalid,
    Overflow,
}
