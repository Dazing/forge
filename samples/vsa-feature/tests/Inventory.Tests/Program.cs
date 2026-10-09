using Inventory.Api.Data;
using Inventory.Api.Features.Inventory;
using Inventory.Api.Features.Reservations;

GetInventory_IsCaseInsensitiveAndReturnsUppercaseSku();
ReceiveStock_RejectsNonPositiveQuantityWithoutMutation();
CreateReservation_RejectsOverReservationWithoutMutation();
ConfirmReservation_ConsumesStockAndRejectsFurtherTransitions();
CancelReservation_RestoresStockExactlyOnce();
Console.WriteLine("PASS: 5 inventory slice behavior checks");

static void GetInventory_IsCaseInsensitiveAndReturnsUppercaseSku()
{
    var state = new InventoryState();

    var item = GetInventory.Execute("widget", state);

    Assert(
        item is { Sku: "WIDGET", Available: 10 },
        "lookup is case-insensitive with uppercase output"
    );
}

static void ReceiveStock_RejectsNonPositiveQuantityWithoutMutation()
{
    var state = new InventoryState();

    var received = ReceiveStock.Execute("part", 3, state);
    var rejected = ReceiveStock.Execute("part", 0, state);
    var overflow = ReceiveStock.Execute("part", int.MaxValue, state);

    Assert(received.Outcome == ReceiveStockOutcome.Received, "positive receipt succeeds");
    Assert(received.Item is { Sku: "PART", Available: 3 }, "receipt creates uppercase stock");
    Assert(rejected.Outcome == ReceiveStockOutcome.Invalid, "non-positive receipt is rejected");
    Assert(overflow.Outcome == ReceiveStockOutcome.Overflow, "overflowing receipt is rejected");
    Assert(
        GetInventory.Execute("part", state)?.Available == 3,
        "rejected receipt does not mutate stock"
    );
}

static void CreateReservation_RejectsOverReservationWithoutMutation()
{
    var state = new InventoryState();

    var created = CreateReservation.Execute("widget", 4, state);
    var rejected = CreateReservation.Execute("widget", 7, state);

    Assert(created.Outcome == CreateReservationOutcome.Created, "reservation is created");
    Assert(
        created.Reservation is { Sku: "WIDGET", Quantity: 4, Status: "Pending" },
        "pending reservation is returned"
    );
    Assert(
        rejected.Outcome == CreateReservationOutcome.InsufficientStock,
        "over-reservation is rejected"
    );
    Assert(
        GetInventory.Execute("widget", state)?.Available == 6,
        "failed creation leaves stock unchanged"
    );
}

static void ConfirmReservation_ConsumesStockAndRejectsFurtherTransitions()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 3, state).Reservation!;

    var confirmed = ConfirmReservation.Execute(created.Id, state);
    var repeated = ConfirmReservation.Execute(created.Id, state);
    var conflicting = CancelReservation.Execute(created.Id, state);

    Assert(confirmed == ConfirmReservationOutcome.Succeeded, "pending reservation confirms");
    Assert(repeated == ConfirmReservationOutcome.NotPending, "repeated confirmation is rejected");
    Assert(
        conflicting == CancelReservationOutcome.NotPending,
        "conflicting cancellation is rejected"
    );
    Assert(
        GetInventory.Execute("widget", state)?.Available == 7,
        "confirmation keeps stock consumed"
    );
}

static void CancelReservation_RestoresStockExactlyOnce()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 4, state).Reservation!;

    var cancelled = CancelReservation.Execute(created.Id, state);
    var repeated = CancelReservation.Execute(created.Id, state);

    Assert(cancelled == CancelReservationOutcome.Succeeded, "pending reservation cancels");
    Assert(repeated == CancelReservationOutcome.NotPending, "repeated cancellation is rejected");
    Assert(
        GetInventory.Execute("widget", state)?.Available == 10,
        "cancellation restores stock once"
    );
}

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException($"FAIL: {message}");
    }
}
