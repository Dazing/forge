var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<InventoryStore>();

var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapGet("/inventory", (InventoryStore store) => Results.Ok(store.GetAll()));
app.MapGet(
    "/inventory/{sku}",
    (string sku, InventoryStore store) =>
        store.TryGet(sku, out var item) ? Results.Ok(item) : Results.NotFound()
);
app.MapPut(
    "/inventory/{sku}",
    (string sku, SetStockRequest request, InventoryStore store) =>
    {
        if (request.Quantity < 0)
        {
            return Results.ValidationProblem(
                new Dictionary<string, string[]> { ["quantity"] = ["Quantity cannot be negative."] }
            );
        }

        return Results.Ok(store.Set(sku, request.Quantity));
    }
);
app.Run();

public sealed record SetStockRequest(int Quantity);

public sealed record InventoryItem(string Sku, int Quantity);

public sealed class InventoryStore
{
    private readonly object _sync = new();
    private readonly Dictionary<string, int> _items = new(StringComparer.OrdinalIgnoreCase)
    {
        ["WIDGET"] = 10,
    };

    public IReadOnlyList<InventoryItem> GetAll()
    {
        lock (_sync)
        {
            return _items
                .OrderBy(pair => pair.Key)
                .Select(pair => new InventoryItem(pair.Key, pair.Value))
                .ToArray();
        }
    }

    public bool TryGet(string sku, out InventoryItem? item)
    {
        lock (_sync)
        {
            if (_items.TryGetValue(sku, out var quantity))
            {
                item = new InventoryItem(sku.ToUpperInvariant(), quantity);
                return true;
            }
        }

        item = null;
        return false;
    }

    public InventoryItem Set(string sku, int quantity)
    {
        lock (_sync)
        {
            _items[sku] = quantity;
            return new InventoryItem(sku.ToUpperInvariant(), quantity);
        }
    }
}
