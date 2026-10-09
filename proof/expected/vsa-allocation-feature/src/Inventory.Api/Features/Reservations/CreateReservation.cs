using Inventory.Api.Data;

namespace Inventory.Api.Features.Reservations;

internal static class CreateReservation
{
    internal static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost(
            "/reservations",
            (CreateReservationRequest request, InventoryState state) =>
            {
                var result = Execute(request.Sku, request.Quantity, state);
                return result.Outcome switch
                {
                    CreateReservationOutcome.Created => Results.Created(
                        $"/reservations/{result.Reservation!.Id}",
                        result.Reservation
                    ),
                    CreateReservationOutcome.Invalid => Results.ValidationProblem(
                        new Dictionary<string, string[]>
                        {
                            [string.IsNullOrWhiteSpace(request.Sku) ? "sku" : "quantity"] =
                            [
                                "SKU must not be blank and quantity must be positive.",
                            ],
                        }
                    ),
                    CreateReservationOutcome.UnknownSku => Results.NotFound(),
                    CreateReservationOutcome.InsufficientStock => Results.Conflict(),
                    _ => throw new InvalidOperationException(
                        "Unknown reservation creation outcome."
                    ),
                };
            }
        );
    }

    internal static CreateReservationResult Execute(string sku, int quantity, InventoryState state)
    {
        if (string.IsNullOrWhiteSpace(sku) || quantity <= 0)
        {
            return new CreateReservationResult(CreateReservationOutcome.Invalid, null);
        }

        var normalizedSku = sku.Trim().ToUpperInvariant();
        lock (state.SyncRoot)
        {
            if (!state.Stock.TryGetValue(normalizedSku, out var locations))
            {
                return new CreateReservationResult(CreateReservationOutcome.UnknownSku, null);
            }

            var orderedLocations = locations
                .Values.OrderBy(location => location.Location, StringComparer.Ordinal)
                .ToArray();
            var totalAllocatable = orderedLocations.Sum(location =>
                (long)Math.Max(0, location.Available - location.SafetyStock)
            );
            if (totalAllocatable < quantity)
            {
                return new CreateReservationResult(
                    CreateReservationOutcome.InsufficientStock,
                    null
                );
            }

            var remaining = quantity;
            var allocations = new List<ReservationAllocationRecord>();
            foreach (var location in orderedLocations)
            {
                var allocated = Math.Min(
                    remaining,
                    Math.Max(0, location.Available - location.SafetyStock)
                );
                if (allocated == 0)
                {
                    continue;
                }

                allocations.Add(new ReservationAllocationRecord(location.Location, allocated));
                locations[location.Location] = location with
                {
                    Available = location.Available - allocated,
                };
                remaining -= allocated;
                if (remaining == 0)
                {
                    break;
                }
            }

            var reservation = new ReservationRecord(
                Guid.NewGuid(),
                normalizedSku,
                quantity,
                ReservationStatus.Pending,
                allocations.ToArray()
            );
            state.Reservations.Add(reservation.Id, reservation);
            state.Version++;
            return new CreateReservationResult(
                CreateReservationOutcome.Created,
                CreateReservationResponse.From(reservation)
            );
        }
    }
}

internal sealed record CreateReservationRequest(string Sku, int Quantity);

internal sealed record CreateReservationResult(
    CreateReservationOutcome Outcome,
    CreateReservationResponse? Reservation
);

internal enum CreateReservationOutcome
{
    Created,
    Invalid,
    UnknownSku,
    InsufficientStock,
}

internal sealed record CreateReservationResponse(
    Guid Id,
    string Sku,
    int Quantity,
    string Status,
    ReservationAllocationResponse[] Allocations
)
{
    internal static CreateReservationResponse From(ReservationRecord reservation) =>
        new(
            reservation.Id,
            reservation.Sku,
            reservation.Quantity,
            reservation.Status.ToString(),
            reservation
                .Allocations.Select(allocation => new ReservationAllocationResponse(
                    allocation.Location,
                    allocation.Quantity
                ))
                .ToArray()
        );
}

internal sealed record ReservationAllocationResponse(string Location, int Quantity);
