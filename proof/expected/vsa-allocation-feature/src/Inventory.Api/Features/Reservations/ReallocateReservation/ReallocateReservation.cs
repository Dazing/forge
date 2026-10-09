using Inventory.Api.Data;

namespace Inventory.Api.Features.Reservations.ReallocateReservation;

internal static class ReallocateReservation
{
    internal static void Map(IEndpointRouteBuilder app)
    {
        app.MapPut("/reservations/{id:guid}/allocations", HandleAsync);
    }

    private static async Task<IResult> HandleAsync(
        Guid id,
        ReallocateReservationRequest request,
        InventoryState state,
        FulfillmentRoutingClient routingClient,
        CancellationToken cancellationToken
    )
    {
        var result = await ExecuteAsync(
            id,
            request.Quantity,
            request.DestinationPostalCode,
            state,
            routingClient,
            cancellationToken
        );
        return result.Outcome switch
        {
            ReallocateReservationOutcome.Succeeded => Results.Ok(result.Reservation),
            ReallocateReservationOutcome.Invalid => Results.ValidationProblem(
                new Dictionary<string, string[]>
                {
                    [request.Quantity <= 0 ? "quantity" : "destinationPostalCode"] =
                    [
                        "Quantity must be positive and destination postal code must not be blank.",
                    ],
                }
            ),
            ReallocateReservationOutcome.NotFound => Results.NotFound(),
            ReallocateReservationOutcome.NotPending
            or ReallocateReservationOutcome.InsufficientStock
            or ReallocateReservationOutcome.StaleSnapshot => Results.Conflict(),
            ReallocateReservationOutcome.RoutingFailure => Results.StatusCode(
                StatusCodes.Status502BadGateway
            ),
            ReallocateReservationOutcome.RoutingTimeout => Results.StatusCode(
                StatusCodes.Status504GatewayTimeout
            ),
            _ => throw new InvalidOperationException("Unknown reallocation outcome."),
        };
    }

    internal static async Task<ReallocateReservationResult> ExecuteAsync(
        Guid id,
        int quantity,
        string destinationPostalCode,
        InventoryState state,
        FulfillmentRoutingClient routingClient,
        CancellationToken cancellationToken
    )
    {
        if (quantity <= 0 || string.IsNullOrWhiteSpace(destinationPostalCode))
        {
            return new ReallocateReservationResult(ReallocateReservationOutcome.Invalid, null);
        }

        ReallocationSnapshot snapshot;
        lock (state.SyncRoot)
        {
            if (!state.Reservations.TryGetValue(id, out var reservation))
            {
                return new ReallocateReservationResult(ReallocateReservationOutcome.NotFound, null);
            }
            if (reservation.Status != ReservationStatus.Pending)
            {
                return new ReallocateReservationResult(
                    ReallocateReservationOutcome.NotPending,
                    null
                );
            }

            var reservationSnapshot = ReservationSnapshot.FromPersistence(reservation);
            var currentByLocation = reservation.Allocations.ToDictionary(
                allocation => allocation.Location,
                allocation => allocation.Quantity,
                StringComparer.OrdinalIgnoreCase
            );
            var locationSnapshots = state
                .Stock[reservation.Sku]
                .Values.Select(location => new LocationSnapshot(
                    location.Location,
                    location.Available,
                    location.SafetyStock,
                    currentByLocation.GetValueOrDefault(location.Location)
                ))
                .ToArray();
            snapshot = new ReallocationSnapshot(
                state.Version,
                reservationSnapshot,
                locationSnapshots
            );
        }

        var routing = await routingClient.GetRoutesAsync(
            snapshot.Reservation.Sku,
            destinationPostalCode.Trim(),
            cancellationToken
        );
        if (routing.Outcome == FulfillmentRoutingOutcome.TimedOut)
        {
            return new ReallocateReservationResult(
                ReallocateReservationOutcome.RoutingTimeout,
                null
            );
        }
        if (routing.Outcome != FulfillmentRoutingOutcome.Succeeded || routing.Routes is null)
        {
            return new ReallocateReservationResult(
                ReallocateReservationOutcome.RoutingFailure,
                null
            );
        }

        var locationsByName = snapshot.Locations.ToDictionary(
            location => location.Location,
            StringComparer.OrdinalIgnoreCase
        );
        var candidates = new List<AllocationCandidate>(routing.Routes.Length);
        foreach (var route in routing.Routes)
        {
            if (!locationsByName.TryGetValue(route.Location, out var location))
            {
                continue;
            }
            candidates.Add(
                new AllocationCandidate(
                    location.Location,
                    location.Available,
                    location.SafetyStock,
                    location.CurrentReservationAllocation
                )
            );
        }
        var decision = AllocationCalculator.Calculate(quantity, candidates);

        lock (state.SyncRoot)
        {
            if (
                state.Version != snapshot.Version
                || !state.Reservations.TryGetValue(id, out var currentReservation)
                || !snapshot.Reservation.Matches(currentReservation)
            )
            {
                return new ReallocateReservationResult(
                    ReallocateReservationOutcome.StaleSnapshot,
                    null
                );
            }

            if (decision is null)
            {
                return new ReallocateReservationResult(
                    ReallocateReservationOutcome.InsufficientStock,
                    null
                );
            }

            if (
                currentReservation.Quantity == quantity
                && AllocationsMatch(currentReservation.Allocations, decision)
            )
            {
                return new ReallocateReservationResult(
                    ReallocateReservationOutcome.Succeeded,
                    ReallocateReservationResponse.FromPersistence(currentReservation)
                );
            }

            var locations = state.Stock[currentReservation.Sku];
            var updatedAvailable = locations.ToDictionary(
                pair => pair.Key,
                pair => pair.Value.Available,
                StringComparer.OrdinalIgnoreCase
            );
            foreach (var allocation in currentReservation.Allocations)
            {
                var restored = (long)updatedAvailable[allocation.Location] + allocation.Quantity;
                if (restored > int.MaxValue)
                {
                    return new ReallocateReservationResult(
                        ReallocateReservationOutcome.InsufficientStock,
                        null
                    );
                }
                updatedAvailable[allocation.Location] = (int)restored;
            }
            foreach (var allocation in decision)
            {
                if (
                    !locations.TryGetValue(allocation.Location, out var location)
                    || updatedAvailable[allocation.Location] - allocation.Quantity
                        < location.SafetyStock
                )
                {
                    return new ReallocateReservationResult(
                        ReallocateReservationOutcome.InsufficientStock,
                        null
                    );
                }
                updatedAvailable[allocation.Location] -= allocation.Quantity;
            }

            foreach (var (locationName, available) in updatedAvailable)
            {
                if (locations[locationName].Available != available)
                {
                    locations[locationName] = locations[locationName] with
                    {
                        Available = available,
                    };
                }
            }
            var updatedReservation = currentReservation with
            {
                Quantity = quantity,
                Allocations = decision
                    .Select(allocation => new ReservationAllocationRecord(
                        allocation.Location,
                        allocation.Quantity
                    ))
                    .ToArray(),
            };
            state.Reservations[id] = updatedReservation;
            state.Version++;
            return new ReallocateReservationResult(
                ReallocateReservationOutcome.Succeeded,
                ReallocateReservationResponse.FromPersistence(updatedReservation)
            );
        }
    }

    private static bool AllocationsMatch(
        IReadOnlyList<ReservationAllocationRecord> current,
        IReadOnlyList<AllocationDecision> decision
    ) =>
        current.Count == decision.Count
        && current
            .Zip(decision)
            .All(pair =>
                string.Equals(pair.First.Location, pair.Second.Location, StringComparison.Ordinal)
                && pair.First.Quantity == pair.Second.Quantity
            );
}

internal sealed record ReallocationSnapshot(
    long Version,
    ReservationSnapshot Reservation,
    LocationSnapshot[] Locations
);

internal sealed record ReservationSnapshot(
    Guid Id,
    string Sku,
    int Quantity,
    ReservationStatus Status,
    ReservationAllocationSnapshot[] Allocations
)
{
    internal static ReservationSnapshot FromPersistence(ReservationRecord reservation) =>
        new(
            reservation.Id,
            reservation.Sku,
            reservation.Quantity,
            reservation.Status,
            reservation
                .Allocations.Select(allocation => new ReservationAllocationSnapshot(
                    allocation.Location,
                    allocation.Quantity
                ))
                .ToArray()
        );

    internal bool Matches(ReservationRecord reservation) =>
        Id == reservation.Id
        && string.Equals(Sku, reservation.Sku, StringComparison.Ordinal)
        && Quantity == reservation.Quantity
        && Status == reservation.Status
        && Allocations.Length == reservation.Allocations.Length
        && Allocations
            .Zip(reservation.Allocations)
            .All(pair =>
                string.Equals(pair.First.Location, pair.Second.Location, StringComparison.Ordinal)
                && pair.First.Quantity == pair.Second.Quantity
            );
}

internal sealed record ReservationAllocationSnapshot(string Location, int Quantity);

internal sealed record LocationSnapshot(
    string Location,
    int Available,
    int SafetyStock,
    int CurrentReservationAllocation
);

internal sealed record ReallocateReservationResult(
    ReallocateReservationOutcome Outcome,
    ReallocateReservationResponse? Reservation
);

internal enum ReallocateReservationOutcome
{
    Succeeded,
    Invalid,
    NotFound,
    NotPending,
    InsufficientStock,
    StaleSnapshot,
    RoutingFailure,
    RoutingTimeout,
}
