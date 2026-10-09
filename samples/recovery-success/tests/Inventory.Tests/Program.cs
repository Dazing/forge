var store = new InventoryStore();
Assert(store.TryGet("widget", out var item), "seeded inventory is available");
Assert(item?.Quantity == 10, "seeded quantity is 10");
Assert(store.Set("part", 3).Quantity == 3, "stock can be set");
Console.WriteLine("PASS: 3 inventory checks");

static void Assert(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException($"FAIL: {message}");
}
