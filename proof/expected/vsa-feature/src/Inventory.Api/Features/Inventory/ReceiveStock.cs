using Inventory.Api.Data;

namespace Inventory.Api.Features.Inventory;

internal static class ReceiveStock
{
    internal static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost(
            "/inventory/{sku}/receipts",
            (string sku, ReceiveStockRequest request, InventoryState state) =>
            {
                var result = Execute(sku, request.Quantity, state);
                return result.Outcome switch
                {
                    ReceiveStockOutcome.Received => Results.Ok(result.Item),
                    ReceiveStockOutcome.Invalid => Results.ValidationProblem(
                        new Dictionary<string, string[]>
                        {
                            [string.IsNullOrWhiteSpace(sku) ? "sku" : "quantity"] =
                            [
                                "SKU must not be blank and quantity must be positive.",
                            ],
                        }
                    ),
                    ReceiveStockOutcome.Overflow => Results.Conflict(),
                    _ => throw new InvalidOperationException("Unknown receipt outcome."),
                };
            }
        );
    }

    internal static ReceiveStockResult Execute(string sku, int quantity, InventoryState state)
    {
        if (string.IsNullOrWhiteSpace(sku) || quantity <= 0)
        {
            return new ReceiveStockResult(ReceiveStockOutcome.Invalid, null);
        }

        var normalizedSku = sku.ToUpperInvariant();
        lock (state.SyncRoot)
        {
            state.Stock.TryGetValue(normalizedSku, out var available);
            if (available > int.MaxValue - quantity)
            {
                return new ReceiveStockResult(ReceiveStockOutcome.Overflow, null);
            }

            available += quantity;
            state.Stock[normalizedSku] = available;
            return new ReceiveStockResult(
                ReceiveStockOutcome.Received,
                new ReceiveStockResponse(normalizedSku, available)
            );
        }
    }
}

internal sealed record ReceiveStockRequest(int Quantity);

internal sealed record ReceiveStockResult(ReceiveStockOutcome Outcome, ReceiveStockResponse? Item);

internal sealed record ReceiveStockResponse(string Sku, int Available);

internal enum ReceiveStockOutcome
{
    Received,
    Invalid,
    Overflow,
}
