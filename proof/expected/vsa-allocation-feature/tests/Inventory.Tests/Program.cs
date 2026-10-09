using System.Net;
using System.Text;
using System.Text.Json;
using Inventory.Api.Data;
using Inventory.Api.Features.Inventory;
using Inventory.Api.Features.Reservations;
using Inventory.Api.Features.Reservations.ReallocateReservation;

BaselineSlices_PreserveLocationAwareBehavior();
AllocationCalculator_VirtuallyReleasesAndNeverReturnsPartialSuccess();
await ReallocateReservation_FollowsMappedRoutingAndCommitsOneDelta();
await ReallocateReservation_IncreaseCancelAndDecreaseConfirmConserveStock();
await ReallocateReservation_SameDecisionIsVersionNeutral();
await ReallocateReservation_InsufficientAndShortCircuitFailuresDoNotMutate();
await ReallocateReservation_MapsUpstreamFailureMalformedPayloadAndTimeout();
await ReallocateReservation_RejectsStaleSnapshotAndPreservesConcurrentWrite();
Console.WriteLine("PASS: 8 baseline and reallocation behavior checks");

static void BaselineSlices_PreserveLocationAwareBehavior()
{
    var state = new InventoryState();
    var initial = GetInventory.Execute(" widget ", state)!;
    Assert(initial is { Sku: "WIDGET", Available: 15 }, "inventory aggregates allocatable stock");
    Assert(
        initial.Locations[0] is { Location: "NORTH", Allocatable: 8 },
        "locations are ordered and exclude safety stock"
    );
    Assert(
        initial.Locations[1] is { Location: "SOUTH", Allocatable: 7 },
        "second location is stable"
    );

    var received = ReceiveLocationStock.Execute("part", "west", 5, state);
    Assert(received.Outcome == ReceiveLocationStockOutcome.Received, "location receipt succeeds");
    Assert(
        received.Item is { Sku: "PART", Location: "WEST", Available: 5 },
        "receipt normalizes identifiers"
    );
    Assert(
        ReceiveLocationStock.Execute("part", "west", 0, state).Outcome
            == ReceiveLocationStockOutcome.Invalid,
        "invalid receipt is rejected"
    );

    var created = CreateReservation.Execute("widget", 10, state).Reservation!;
    Assert(
        created.Allocations[0] is { Location: "NORTH", Quantity: 8 },
        "creation is greedy and safety-aware"
    );
    Assert(
        created.Allocations[1] is { Location: "SOUTH", Quantity: 2 },
        "creation spans locations deterministically"
    );
    Assert(
        GetReservation.Execute(created.Id, state)?.Quantity == 10,
        "reservation lookup returns complete state"
    );
    Assert(
        ConfirmReservation.Execute(created.Id, state) == ConfirmReservationOutcome.Succeeded,
        "pending reservation confirms"
    );
    Assert(
        CancelReservation.Execute(created.Id, state) == CancelReservationOutcome.NotPending,
        "confirmed reservation cannot cancel"
    );

    var cancelled = CreateReservation.Execute("widget", 5, state).Reservation!;
    Assert(
        CancelReservation.Execute(cancelled.Id, state) == CancelReservationOutcome.Succeeded,
        "pending reservation cancels"
    );
    Assert(
        CancelReservation.Execute(cancelled.Id, state) == CancelReservationOutcome.NotPending,
        "cancellation restores once"
    );
    Assert(
        GetInventory.Execute("widget", state)?.Available == 5,
        "confirmed quantity remains consumed after another cancellation"
    );
}

static void AllocationCalculator_VirtuallyReleasesAndNeverReturnsPartialSuccess()
{
    var candidates = new[]
    {
        new AllocationCandidate("SOUTH", 4, 1, 3),
        new AllocationCandidate("NORTH", 3, 2, 5),
    };

    var decision = AllocationCalculator.Calculate(8, candidates);
    var insufficient = AllocationCalculator.Calculate(13, candidates);

    Assert(decision is { Length: 2 }, "complete calculation succeeds");
    Assert(
        decision![0] is { Location: "SOUTH", Quantity: 6 },
        "first route uses virtually released capacity"
    );
    Assert(
        decision[1] is { Location: "NORTH", Quantity: 2 },
        "remaining quantity follows route order"
    );
    Assert(insufficient is null, "calculator never returns a partial successful decision");
}

static async Task ReallocateReservation_FollowsMappedRoutingAndCommitsOneDelta()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 6, state).Reservation!;
    var outboundSku = "";
    var outboundPostalCode = "";
    using var routing = new RoutingHarness(
        async (request, _) =>
        {
            using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            outboundSku = payload.RootElement.GetProperty("sku").GetString()!;
            outboundPostalCode = payload
                .RootElement.GetProperty("destinationPostalCode")
                .GetString()!;
            return JsonResponse(
                HttpStatusCode.OK,
                """{"routes":[{"location":"north","priority":2},{"location":" south ","priority":1}]}"""
            );
        }
    );

    var result = await ReallocateReservation.ExecuteAsync(
        created.Id,
        10,
        " 94105 ",
        state,
        routing.Client,
        CancellationToken.None
    );

    Assert(result.Outcome == ReallocateReservationOutcome.Succeeded, "valid reallocation succeeds");
    Assert(
        result.Reservation is { Quantity: 10, Status: "Pending" },
        "complete pending response is mapped"
    );
    Assert(
        result.Reservation!.Allocations[0] is { Location: "SOUTH", Quantity: 7 },
        "external location is normalized and prioritized"
    );
    Assert(
        result.Reservation.Allocations[1] is { Location: "NORTH", Quantity: 3 },
        "remaining quantity uses second route"
    );
    Assert(
        outboundSku == "WIDGET" && outboundPostalCode == "94105",
        "outbound request is explicitly mapped"
    );
    Assert(routing.CallCount == 1, "one outbound request is sent");
    Assert(
        GetInventory.Execute("widget", state)?.Available == 5,
        "stock changes only by the old/new allocation delta"
    );
    Assert(state.Version == 2, "creation and reallocation each increment version once");
}

static async Task ReallocateReservation_IncreaseCancelAndDecreaseConfirmConserveStock()
{
    var increasedState = new InventoryState();
    var increased = CreateReservation.Execute("widget", 4, increasedState).Reservation!;
    using var southFirst = new RoutingHarness(
        (_, _) =>
            Task.FromResult(
                JsonResponse(
                    HttpStatusCode.OK,
                    """{"routes":[{"location":"south","priority":1},{"location":"north","priority":2}]}"""
                )
            )
    );
    var increaseResult = await ReallocateReservation.ExecuteAsync(
        increased.Id,
        9,
        "94105",
        increasedState,
        southFirst.Client,
        CancellationToken.None
    );
    Assert(increaseResult.Outcome == ReallocateReservationOutcome.Succeeded, "increase succeeds");
    Assert(
        CancelReservation.Execute(increased.Id, increasedState)
            == CancelReservationOutcome.Succeeded,
        "reallocated reservation cancels"
    );
    Assert(
        GetInventory.Execute("widget", increasedState)?.Available == 15,
        "cancellation restores final allocations exactly once"
    );

    var decreasedState = new InventoryState();
    var decreased = CreateReservation.Execute("widget", 10, decreasedState).Reservation!;
    using var northFirst = new RoutingHarness(
        (_, _) =>
            Task.FromResult(
                JsonResponse(
                    HttpStatusCode.OK,
                    """{"routes":[{"location":"north","priority":1},{"location":"south","priority":2}]}"""
                )
            )
    );
    var decreaseResult = await ReallocateReservation.ExecuteAsync(
        decreased.Id,
        3,
        "10001",
        decreasedState,
        northFirst.Client,
        CancellationToken.None
    );
    Assert(decreaseResult.Outcome == ReallocateReservationOutcome.Succeeded, "decrease succeeds");
    Assert(
        ConfirmReservation.Execute(decreased.Id, decreasedState)
            == ConfirmReservationOutcome.Succeeded,
        "decreased reservation confirms"
    );
    Assert(
        CancelReservation.Execute(decreased.Id, decreasedState)
            == CancelReservationOutcome.NotPending,
        "confirmed reservation cannot restore stock"
    );
    Assert(
        GetInventory.Execute("widget", decreasedState)?.Available == 12,
        "only final confirmed quantity remains consumed"
    );
}

static async Task ReallocateReservation_SameDecisionIsVersionNeutral()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 6, state).Reservation!;
    var version = state.Version;
    var inventory = InventoryFingerprint(GetInventory.Execute("widget", state)!);
    using var routing = new RoutingHarness(
        (_, _) =>
            Task.FromResult(
                JsonResponse(
                    HttpStatusCode.OK,
                    """{"routes":[{"location":"north","priority":1},{"location":"south","priority":2}]}"""
                )
            )
    );

    var result = await ReallocateReservation.ExecuteAsync(
        created.Id,
        6,
        "10001",
        state,
        routing.Client,
        CancellationToken.None
    );

    Assert(result.Outcome == ReallocateReservationOutcome.Succeeded, "same decision succeeds");
    Assert(
        result.Reservation!.Allocations[0] is { Location: "NORTH", Quantity: 6 },
        "same decision is returned"
    );
    Assert(state.Version == version, "same decision does not increment version");
    Assert(
        InventoryFingerprint(GetInventory.Execute("widget", state)!) == inventory,
        "same decision does not change stock representation"
    );
}

static async Task ReallocateReservation_InsufficientAndShortCircuitFailuresDoNotMutate()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 4, state).Reservation!;
    using var routing = new RoutingHarness(
        (_, _) =>
            Task.FromResult(
                JsonResponse(
                    HttpStatusCode.OK,
                    """{"routes":[{"location":"central","priority":1},{"location":"north","priority":2},{"location":"south","priority":3}]}"""
                )
            )
    );
    var beforeVersion = state.Version;
    var beforeInventory = InventoryFingerprint(GetInventory.Execute("widget", state)!);
    var beforeReservation = ReservationFingerprint(GetReservation.Execute(created.Id, state)!);

    var insufficient = await ReallocateReservation.ExecuteAsync(
        created.Id,
        16,
        "60601",
        state,
        routing.Client,
        CancellationToken.None
    );
    Assert(
        insufficient.Outcome == ReallocateReservationOutcome.InsufficientStock,
        "unknown routed location is ignored and insufficient capacity conflicts"
    );
    Assert(state.Version == beforeVersion, "insufficient result does not increment version");
    Assert(
        InventoryFingerprint(GetInventory.Execute("widget", state)!) == beforeInventory,
        "insufficient result preserves stock"
    );
    Assert(
        ReservationFingerprint(GetReservation.Execute(created.Id, state)!) == beforeReservation,
        "insufficient result preserves reservation"
    );

    var calls = routing.CallCount;
    Assert(
        (
            await ReallocateReservation.ExecuteAsync(
                created.Id,
                0,
                "94105",
                state,
                routing.Client,
                CancellationToken.None
            )
        ).Outcome == ReallocateReservationOutcome.Invalid,
        "zero quantity is invalid"
    );
    Assert(
        (
            await ReallocateReservation.ExecuteAsync(
                created.Id,
                5,
                " ",
                state,
                routing.Client,
                CancellationToken.None
            )
        ).Outcome == ReallocateReservationOutcome.Invalid,
        "blank postal code is invalid"
    );
    Assert(
        (
            await ReallocateReservation.ExecuteAsync(
                Guid.NewGuid(),
                5,
                "94105",
                state,
                routing.Client,
                CancellationToken.None
            )
        ).Outcome == ReallocateReservationOutcome.NotFound,
        "unknown reservation is rejected"
    );
    Assert(
        ConfirmReservation.Execute(created.Id, state) == ConfirmReservationOutcome.Succeeded,
        "reservation becomes terminal"
    );
    var terminalVersion = state.Version;
    Assert(
        (
            await ReallocateReservation.ExecuteAsync(
                created.Id,
                5,
                "94105",
                state,
                routing.Client,
                CancellationToken.None
            )
        ).Outcome == ReallocateReservationOutcome.NotPending,
        "terminal reservation is rejected"
    );
    Assert(
        routing.CallCount == calls,
        "syntax, unknown, and terminal failures do not call routing"
    );
    Assert(state.Version == terminalVersion, "terminal failure is mutation-free");
}

static async Task ReallocateReservation_MapsUpstreamFailureMalformedPayloadAndTimeout()
{
    await AssertRoutingFailure(
        new RoutingHarness(
            (_, _) => Task.FromResult(JsonResponse(HttpStatusCode.ServiceUnavailable, "{}"))
        ),
        ReallocateReservationOutcome.RoutingFailure,
        "non-success routing response maps to failure"
    );
    await AssertRoutingFailure(
        new RoutingHarness(
            (_, _) =>
                Task.FromResult(
                    JsonResponse(
                        HttpStatusCode.OK,
                        """{"routes":[{"location":"north","priority":1},{"location":"NORTH","priority":2}]}"""
                    )
                )
        ),
        ReallocateReservationOutcome.RoutingFailure,
        "duplicate normalized location maps to failure"
    );
    await AssertRoutingFailure(
        new RoutingHarness(
            (_, _) =>
                Task.FromResult(
                    JsonResponse(
                        HttpStatusCode.OK,
                        """{"routes":[{"location":"north","priority":1},{"location":"south","priority":1}]}"""
                    )
                )
        ),
        ReallocateReservationOutcome.RoutingFailure,
        "duplicate priority maps to failure"
    );
    await AssertRoutingFailure(
        new RoutingHarness(
            (_, _) =>
                Task.FromResult(
                    JsonResponse(
                        HttpStatusCode.OK,
                        """{"routes":[{"location":" ","priority":1}]}"""
                    )
                )
        ),
        ReallocateReservationOutcome.RoutingFailure,
        "blank location maps to failure"
    );
    await AssertRoutingFailure(
        new RoutingHarness(
            (_, _) =>
                Task.FromResult(
                    JsonResponse(
                        HttpStatusCode.OK,
                        """{"routes":[{"location":"north","priority":0}]}"""
                    )
                )
        ),
        ReallocateReservationOutcome.RoutingFailure,
        "non-positive priority maps to failure"
    );
    await AssertRoutingFailure(
        new RoutingHarness(
            (_, _) => Task.FromResult(JsonResponse(HttpStatusCode.OK, """{"routes":"""))
        ),
        ReallocateReservationOutcome.RoutingFailure,
        "invalid JSON maps to failure"
    );
    await AssertRoutingFailure(
        new RoutingHarness(
            async (_, cancellationToken) =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return JsonResponse(HttpStatusCode.OK, "{}");
            },
            TimeSpan.FromMilliseconds(25)
        ),
        ReallocateReservationOutcome.RoutingTimeout,
        "routing timeout maps separately"
    );
}

static async Task AssertRoutingFailure(
    RoutingHarness routing,
    ReallocateReservationOutcome expected,
    string message
)
{
    using (routing)
    {
        var state = new InventoryState();
        var created = CreateReservation.Execute("widget", 4, state).Reservation!;
        var version = state.Version;
        var inventory = InventoryFingerprint(GetInventory.Execute("widget", state)!);
        var reservation = ReservationFingerprint(GetReservation.Execute(created.Id, state)!);

        var result = await ReallocateReservation.ExecuteAsync(
            created.Id,
            7,
            "failure",
            state,
            routing.Client,
            CancellationToken.None
        );

        Assert(result.Outcome == expected, message);
        Assert(state.Version == version, "routing failure does not increment version");
        Assert(
            InventoryFingerprint(GetInventory.Execute("widget", state)!) == inventory,
            "routing failure preserves stock"
        );
        Assert(
            ReservationFingerprint(GetReservation.Execute(created.Id, state)!) == reservation,
            "routing failure preserves reservation"
        );
    }
}

static async Task ReallocateReservation_RejectsStaleSnapshotAndPreservesConcurrentWrite()
{
    var state = new InventoryState();
    var created = CreateReservation.Execute("widget", 4, state).Reservation!;
    var beforeInventory = InventoryFingerprint(GetInventory.Execute("widget", state)!);
    using var routing = new RoutingHarness(
        async (_, cancellationToken) =>
        {
            await Task.Run(
                () => ReceiveLocationStock.Execute("concurrent", "north", 2, state),
                cancellationToken
            );
            return JsonResponse(
                HttpStatusCode.OK,
                """{"routes":[{"location":"south","priority":1},{"location":"north","priority":2}]}"""
            );
        }
    );

    var result = await ReallocateReservation.ExecuteAsync(
        created.Id,
        8,
        "94105",
        state,
        routing.Client,
        CancellationToken.None
    );

    Assert(
        result.Outcome == ReallocateReservationOutcome.StaleSnapshot,
        "concurrent version change rejects stale decision"
    );
    Assert(
        InventoryFingerprint(GetInventory.Execute("widget", state)!) == beforeInventory,
        "stale decision does not mutate reservation stock"
    );
    Assert(
        GetReservation.Execute(created.Id, state)?.Quantity == 4,
        "stale decision does not mutate reservation"
    );
    Assert(
        GetInventory.Execute("concurrent", state)?.Available == 2,
        "concurrent write is preserved"
    );
    Assert(state.Version == 2, "only creation and concurrent receipt increment version");
}

static string InventoryFingerprint(InventoryResponse inventory) =>
    $"{inventory.Sku}:{inventory.Available}:"
    + string.Join(
        "|",
        inventory.Locations.Select(location =>
            $"{location.Location},{location.Available},{location.SafetyStock},{location.Allocatable}"
        )
    );

static string ReservationFingerprint(GetReservationResponse reservation) =>
    $"{reservation.Id}:{reservation.Sku}:{reservation.Quantity}:{reservation.Status}:"
    + string.Join(
        "|",
        reservation.Allocations.Select(allocation => $"{allocation.Location},{allocation.Quantity}")
    );

static HttpResponseMessage JsonResponse(HttpStatusCode status, string json) =>
    new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException($"FAIL: {message}");
    }
}

internal sealed class RoutingHarness : IDisposable
{
    private readonly HttpClient _httpClient;
    private readonly RecordingHandler _handler;

    internal RoutingHarness(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> response,
        TimeSpan? timeout = null
    )
    {
        _handler = new RecordingHandler(response);
        _httpClient = new HttpClient(_handler)
        {
            BaseAddress = new Uri("http://routing.invalid/"),
            Timeout = timeout ?? TimeSpan.FromMilliseconds(500),
        };
        Client = new FulfillmentRoutingClient(_httpClient);
    }

    internal FulfillmentRoutingClient Client { get; }

    internal int CallCount => _handler.CallCount;

    public void Dispose() => _httpClient.Dispose();
}

internal sealed class RecordingHandler(
    Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> response
) : HttpMessageHandler
{
    internal int CallCount { get; private set; }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken
    )
    {
        CallCount++;
        return response(request, cancellationToken);
    }
}
