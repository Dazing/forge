using Inventory.Api.Data;
using Inventory.Api.Features.Inventory;
using Inventory.Api.Features.Reservations;

GetInventory_IsCaseInsensitiveAndReturnsUppercaseSku();
ReceiveStock_RejectsNonPositiveQuantityWithoutMutation();
CreateReservation_RejectsOverReservationWithoutMutation();
ConfirmReservation_ConsumesStockAndRejectsFurtherTransitions();
CancelReservation_RestoresStockExactlyOnce();
AdjustReservation_IncreasesAndCancellationRestoresAdjustedQuantity();
AdjustReservation_DecreasesAndConfirmationKeepsAdjustedQuantityConsumed();
AdjustReservation_RejectsInvalidInsufficientAndTerminalChangesWithoutMutation();
AdjustReservation_AllowsSameQuantityWithoutMutation();
AdjustReservation_RejectsStockOverflowWithoutMutation();
Console.WriteLine("PASS: 10 inventory slice behavior checks");

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

static void AdjustReservation_IncreasesAndCancellationRestoresAdjustedQuantity()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 4, state).Reservation!;

    var adjusted = AdjustReservationQuantity.Execute(created.Id, 7, state);
    var cancelled = CancelReservation.Execute(created.Id, state);

    Assert(adjusted.Outcome == AdjustReservationQuantityOutcome.Adjusted, "increase succeeds");
    Assert(
        adjusted.Reservation is { Quantity: 7, Status: "Pending" },
        "increase returns updated reservation"
    );
    Assert(cancelled == CancelReservationOutcome.Succeeded, "adjusted reservation cancels");
    Assert(
        GetInventory.Execute("widget", state)?.Available == 10,
        "cancellation restores adjusted quantity"
    );
}

static void AdjustReservation_DecreasesAndConfirmationKeepsAdjustedQuantityConsumed()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 6, state).Reservation!;

    var adjusted = AdjustReservationQuantity.Execute(created.Id, 2, state);
    var confirmed = ConfirmReservation.Execute(created.Id, state);

    Assert(adjusted.Outcome == AdjustReservationQuantityOutcome.Adjusted, "decrease succeeds");
    Assert(confirmed == ConfirmReservationOutcome.Succeeded, "adjusted reservation confirms");
    Assert(
        GetInventory.Execute("widget", state)?.Available == 8,
        "confirmation keeps adjusted quantity consumed"
    );
}

static void AdjustReservation_RejectsInvalidInsufficientAndTerminalChangesWithoutMutation()
{
    var state = new InventoryState();
    var pending = CreateReservation.Execute("widget", 4, state).Reservation!;

    var invalid = AdjustReservationQuantity.Execute(pending.Id, 0, state);
    var insufficient = AdjustReservationQuantity.Execute(pending.Id, 11, state);
    var confirmed = ConfirmReservation.Execute(pending.Id, state);
    var terminal = AdjustReservationQuantity.Execute(pending.Id, 3, state);
    var unknown = AdjustReservationQuantity.Execute(Guid.NewGuid(), 1, state);

    Assert(
        invalid.Outcome == AdjustReservationQuantityOutcome.Invalid,
        "non-positive quantity is rejected"
    );
    Assert(
        insufficient.Outcome == AdjustReservationQuantityOutcome.InsufficientStock,
        "insufficient increase is rejected"
    );
    Assert(
        confirmed == ConfirmReservationOutcome.Succeeded,
        "reservation confirms after rejected changes"
    );
    Assert(
        terminal.Outcome == AdjustReservationQuantityOutcome.NotPending,
        "confirmed reservation is rejected"
    );
    Assert(
        unknown.Outcome == AdjustReservationQuantityOutcome.NotFound,
        "unknown reservation is rejected"
    );
    Assert(
        GetInventory.Execute("widget", state)?.Available == 6,
        "rejections leave stock unchanged"
    );
}

static void AdjustReservation_AllowsSameQuantityWithoutMutation()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 4, state).Reservation!;

    var adjusted = AdjustReservationQuantity.Execute(created.Id, 4, state);

    Assert(adjusted.Outcome == AdjustReservationQuantityOutcome.Adjusted, "same quantity succeeds");
    Assert(adjusted.Reservation?.Quantity == 4, "same quantity returns current reservation");
    Assert(
        GetInventory.Execute("widget", state)?.Available == 6,
        "same quantity does not mutate stock"
    );
}

static void AdjustReservation_RejectsStockOverflowWithoutMutation()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 4, state).Reservation!;
    var filled = ReceiveStock.Execute("widget", int.MaxValue - 6, state);

    var rejected = AdjustReservationQuantity.Execute(created.Id, 3, state);
    var unchanged = AdjustReservationQuantity.Execute(created.Id, 4, state);

    Assert(
        filled.Item?.Available == int.MaxValue,
        "receipt fills available stock to integer maximum"
    );
    Assert(
        rejected.Outcome == AdjustReservationQuantityOutcome.InsufficientStock,
        "adjustment that would overflow available stock is rejected"
    );
    Assert(unchanged.Reservation?.Quantity == 4, "overflow rejection leaves quantity unchanged");
    Assert(
        GetInventory.Execute("widget", state)?.Available == int.MaxValue,
        "overflow rejection leaves stock unchanged"
    );
}

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException($"FAIL: {message}");
    }
}
