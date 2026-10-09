var store = new ReservationStore();
Assert(store.TryCreate("widget", 4, out var reservation), "reservation created");
Assert(store.Inventory("widget").Available == 6, "reservation removes available stock");
Assert(store.Cancel(reservation!.Id), "pending reservation cancels");
Assert(store.Inventory("widget").Available == 10, "first cancellation restores stock");
Console.WriteLine("PASS: 4 reservation baseline checks");
static void Assert(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException($"FAIL: {message}");
}
