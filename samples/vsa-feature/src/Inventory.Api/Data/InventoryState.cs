namespace Inventory.Api.Data;

internal sealed class InventoryState
{
    internal object SyncRoot { get; } = new();

    internal Dictionary<string, int> Stock { get; } =
        new(StringComparer.OrdinalIgnoreCase) { ["WIDGET"] = 10 };

    internal Dictionary<Guid, ReservationRecord> Reservations { get; } = [];
}

internal sealed record ReservationRecord(
    Guid Id,
    string Sku,
    int Quantity,
    ReservationStatus Status
);

internal enum ReservationStatus
{
    Pending,
    Confirmed,
    Cancelled,
}
