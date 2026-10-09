var cancelled = new ReservationStore();
Assert(cancelled.TryCreate("widget", 4, out var first), "reservation created");
Assert(cancelled.Cancel(first!.Id), "pending cancels");
Assert(!cancelled.Cancel(first.Id), "cancelled cannot cancel again");
Assert(cancelled.Inventory("widget").Available == 10, "cancellation restores once");
var confirmed = new ReservationStore();
Assert(confirmed.TryCreate("widget", 3, out var second), "second reservation created");
Assert(confirmed.Confirm(second!.Id), "pending confirms");
Assert(!confirmed.Cancel(second.Id), "confirmed cannot cancel");
Assert(confirmed.Inventory("widget").Available == 7, "confirmed stock stays consumed");
Console.WriteLine("PASS: 8 transition checks");
static void Assert(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException($"FAIL: {message}");
}
