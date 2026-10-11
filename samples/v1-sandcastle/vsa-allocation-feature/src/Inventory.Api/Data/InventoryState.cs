namespace Inventory.Api.Data;

internal sealed class InventoryState
{
    internal object SyncRoot { get; } = new();

    internal Dictionary<string, Dictionary<string, LocationStockRecord>> Stock { get; } =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["WIDGET"] = new Dictionary<string, LocationStockRecord>(
                StringComparer.OrdinalIgnoreCase
            )
            {
                ["NORTH"] = new("WIDGET", "NORTH", 10, 2),
                ["SOUTH"] = new("WIDGET", "SOUTH", 8, 1),
            },
        };

    internal Dictionary<Guid, ReservationRecord> Reservations { get; } = [];

    internal long Version { get; set; }
}

internal sealed record LocationStockRecord(
    string Sku,
    string Location,
    int Available,
    int SafetyStock
);

internal sealed record ReservationRecord(
    Guid Id,
    string Sku,
    int Quantity,
    ReservationStatus Status,
    ReservationAllocationRecord[] Allocations
);

internal sealed record ReservationAllocationRecord(string Location, int Quantity);

internal enum ReservationStatus
{
    Pending,
    Confirmed,
    Cancelled,
}
