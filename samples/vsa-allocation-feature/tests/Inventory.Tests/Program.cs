using Inventory.Api.Data;
using Inventory.Api.Features.Inventory;
using Inventory.Api.Features.Reservations;

GetInventory_NormalizesAndOrdersLocationAwareStock();
ReceiveLocationStock_ValidatesOverflowAndVersioning();
CreateReservation_AllocatesGreedilyWithoutCrossingSafetyStock();
CreateReservation_FailuresAreMutationFree();
GetReservation_ReturnsCompleteStableRepresentation();
ConfirmReservation_ConsumesStockAndRejectsFurtherTransitions();
CancelReservation_RestoresEveryAllocationExactlyOnce();
ReservationLifecycle_ConservesPhysicalStock();
Console.WriteLine("PASS: 8 location-aware inventory slice behavior checks");

static void GetInventory_NormalizesAndOrdersLocationAwareStock()
{
    var state = new InventoryState();

    var item = GetInventory.Execute(" widget ", state);

    Assert(
        item is { Sku: "WIDGET", Available: 15 },
        "lookup normalizes SKU and aggregates allocatable stock"
    );
    Assert(item!.Locations.Length == 2, "both seeded locations are returned");
    Assert(
        item.Locations[0] is { Location: "NORTH", Available: 10, SafetyStock: 2, Allocatable: 8 },
        "NORTH is first with safety stock excluded"
    );
    Assert(
        item.Locations[1] is { Location: "SOUTH", Available: 8, SafetyStock: 1, Allocatable: 7 },
        "SOUTH is second with safety stock excluded"
    );
    Assert(GetInventory.Execute("missing", state) is null, "unknown SKU is absent");
}

static void ReceiveLocationStock_ValidatesOverflowAndVersioning()
{
    var state = new InventoryState();

    var received = ReceiveLocationStock.Execute(" part ", " west ", 3, state);
    var rejected = ReceiveLocationStock.Execute("part", "west", 0, state);
    var blank = ReceiveLocationStock.Execute("part", " ", 1, state);
    var blankSku = ReceiveLocationStock.Execute(" ", "west", 1, state);
    var filled = ReceiveLocationStock.Execute("overflow", "only", int.MaxValue, state);
    var overflow = ReceiveLocationStock.Execute("overflow", "only", 1, state);

    Assert(received.Outcome == ReceiveLocationStockOutcome.Received, "positive receipt succeeds");
    Assert(
        received.Item
            is { Sku: "PART", Location: "WEST", Available: 3, SafetyStock: 0, Allocatable: 3 },
        "receipt creates normalized location stock"
    );
    Assert(
        rejected.Outcome == ReceiveLocationStockOutcome.Invalid,
        "non-positive receipt is rejected"
    );
    Assert(blank.Outcome == ReceiveLocationStockOutcome.Invalid, "blank location is rejected");
    Assert(blankSku.Outcome == ReceiveLocationStockOutcome.Invalid, "blank SKU is rejected");
    Assert(
        filled.Outcome == ReceiveLocationStockOutcome.Received,
        "maximum initial receipt succeeds"
    );
    Assert(
        overflow.Outcome == ReceiveLocationStockOutcome.Overflow,
        "overflowing receipt is rejected"
    );
    Assert(
        GetInventory.Execute("part", state)?.Available == 3,
        "invalid receipts do not mutate stock"
    );
    Assert(
        GetInventory.Execute("overflow", state)?.Available == int.MaxValue,
        "overflow does not mutate stock"
    );
    Assert(state.Version == 2, "only the two successful receipts increment version");
}

static void CreateReservation_AllocatesGreedilyWithoutCrossingSafetyStock()
{
    var state = new InventoryState();

    var result = CreateReservation.Execute("widget", 10, state);

    Assert(result.Outcome == CreateReservationOutcome.Created, "reservation is created");
    Assert(
        result.Reservation is { Sku: "WIDGET", Quantity: 10, Status: "Pending" },
        "pending reservation is returned"
    );
    Assert(result.Reservation!.Allocations.Length == 2, "reservation spans two locations");
    Assert(
        result.Reservation.Allocations[0] is { Location: "NORTH", Quantity: 8 },
        "NORTH allocatable stock is consumed first"
    );
    Assert(
        result.Reservation.Allocations[1] is { Location: "SOUTH", Quantity: 2 },
        "remaining quantity is allocated from SOUTH"
    );
    var inventory = GetInventory.Execute("widget", state)!;
    Assert(
        inventory.Available == 5,
        "aggregate allocatable stock decreases by reservation quantity"
    );
    Assert(
        inventory.Locations[0].Available == 2,
        "NORTH safety stock remains physical and unallocated"
    );
    Assert(
        inventory.Locations[1].Available == 6,
        "SOUTH physical stock decreases only by its allocation"
    );
    Assert(state.Version == 1, "creation increments version once");
}

static void CreateReservation_FailuresAreMutationFree()
{
    var state = new InventoryState();

    var invalid = CreateReservation.Execute("widget", 0, state);
    var blankSku = CreateReservation.Execute(" ", 1, state);
    var missing = CreateReservation.Execute("missing", 1, state);
    var insufficient = CreateReservation.Execute("widget", 16, state);

    Assert(
        invalid.Outcome == CreateReservationOutcome.Invalid,
        "non-positive quantity is rejected"
    );
    Assert(
        blankSku.Outcome == CreateReservationOutcome.Invalid,
        "blank reservation SKU is rejected"
    );
    Assert(missing.Outcome == CreateReservationOutcome.UnknownSku, "unknown SKU is rejected");
    Assert(
        insufficient.Outcome == CreateReservationOutcome.InsufficientStock,
        "insufficient stock is rejected"
    );
    Assert(
        GetInventory.Execute("widget", state)?.Available == 15,
        "failed creation leaves stock unchanged"
    );
    Assert(state.Reservations.Count == 0, "failed creation stores no reservation");
    Assert(state.Version == 0, "failed creation does not increment version");
}

static void GetReservation_ReturnsCompleteStableRepresentation()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 9, state).Reservation!;

    var found = GetReservation.Execute(created.Id, state);

    Assert(
        found is { Sku: "WIDGET", Quantity: 9, Status: "Pending" },
        "reservation lookup returns stable fields"
    );
    Assert(found!.Allocations.Length == 2, "reservation lookup returns every allocation");
    Assert(
        found.Allocations[0] is { Location: "NORTH", Quantity: 8 },
        "lookup preserves allocation order"
    );
    Assert(
        found.Allocations[1] is { Location: "SOUTH", Quantity: 1 },
        "lookup preserves remaining allocation"
    );
    Assert(GetReservation.Execute(Guid.NewGuid(), state) is null, "unknown reservation is absent");
}

static void ConfirmReservation_ConsumesStockAndRejectsFurtherTransitions()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 3, state).Reservation!;

    var confirmed = ConfirmReservation.Execute(created.Id, state);
    var repeated = ConfirmReservation.Execute(created.Id, state);
    var conflicting = CancelReservation.Execute(created.Id, state);
    var missing = ConfirmReservation.Execute(Guid.NewGuid(), state);

    Assert(confirmed == ConfirmReservationOutcome.Succeeded, "pending reservation confirms");
    Assert(repeated == ConfirmReservationOutcome.NotPending, "repeated confirmation is rejected");
    Assert(
        conflicting == CancelReservationOutcome.NotPending,
        "conflicting cancellation is rejected"
    );
    Assert(missing == ConfirmReservationOutcome.NotFound, "unknown confirmation is rejected");
    Assert(
        GetInventory.Execute("widget", state)?.Available == 12,
        "confirmation keeps stock consumed"
    );
    Assert(state.Version == 2, "creation and confirmation each increment version once");
}

static void CancelReservation_RestoresEveryAllocationExactlyOnce()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 10, state).Reservation!;

    var cancelled = CancelReservation.Execute(created.Id, state);
    var repeated = CancelReservation.Execute(created.Id, state);
    var missing = CancelReservation.Execute(Guid.NewGuid(), state);

    Assert(cancelled == CancelReservationOutcome.Succeeded, "pending reservation cancels");
    Assert(repeated == CancelReservationOutcome.NotPending, "repeated cancellation is rejected");
    Assert(missing == CancelReservationOutcome.NotFound, "unknown cancellation is rejected");
    Assert(
        GetInventory.Execute("widget", state)?.Available == 15,
        "cancellation restores both locations once"
    );
    Assert(
        GetReservation.Execute(created.Id, state)?.Status == "Cancelled",
        "cancelled representation is stable"
    );
    Assert(state.Version == 2, "creation and cancellation each increment version once");
}

static void ReservationLifecycle_ConservesPhysicalStock()
{
    var state = new InventoryState();
    var before = PhysicalStock(state, "WIDGET");
    var first = CreateReservation.Execute("widget", 11, state).Reservation!;
    var second = CreateReservation.Execute("widget", 4, state).Reservation!;

    Assert(
        GetInventory.Execute("widget", state)?.Available == 0,
        "all allocatable stock can be reserved safely"
    );
    Assert(
        ConfirmReservation.Execute(first.Id, state) == ConfirmReservationOutcome.Succeeded,
        "first reservation confirms"
    );
    Assert(
        CancelReservation.Execute(second.Id, state) == CancelReservationOutcome.Succeeded,
        "second reservation cancels"
    );
    Assert(
        GetInventory.Execute("widget", state)?.Available == 4,
        "only cancelled allocation is restored"
    );
    Assert(
        PhysicalStock(state, "WIDGET") + first.Quantity == before,
        "confirmed consumption plus physical stock is conserved"
    );
}

static int PhysicalStock(InventoryState state, string sku)
{
    lock (state.SyncRoot)
    {
        return state.Stock[sku].Values.Sum(location => location.Available);
    }
}

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException($"FAIL: {message}");
    }
}
