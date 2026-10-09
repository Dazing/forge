using Inventory.Api.Data;

namespace Inventory.Api.Features.Reservations;

internal static class AdjustReservationQuantity
{
    internal static void Map(IEndpointRouteBuilder app)
    {
        app.MapPatch(
            "/reservations/{id:guid}",
            (Guid id, AdjustReservationQuantityRequest request, InventoryState state) =>
            {
                var result = Execute(id, request.Quantity, state);
                return result.Outcome switch
                {
                    AdjustReservationQuantityOutcome.Adjusted => Results.Ok(result.Reservation),
                    AdjustReservationQuantityOutcome.Invalid => Results.ValidationProblem(
                        new Dictionary<string, string[]>
                        {
                            ["quantity"] = ["Quantity must be positive."],
                        }
                    ),
                    AdjustReservationQuantityOutcome.NotFound => Results.NotFound(),
                    AdjustReservationQuantityOutcome.NotPending
                    or AdjustReservationQuantityOutcome.InsufficientStock => Results.Conflict(),
                    _ => throw new InvalidOperationException(
                        "Unknown reservation adjustment outcome."
                    ),
                };
            }
        );
    }

    internal static AdjustReservationQuantityResult Execute(
        Guid id,
        int requestedQuantity,
        InventoryState state
    )
    {
        if (requestedQuantity <= 0)
        {
            return new AdjustReservationQuantityResult(
                AdjustReservationQuantityOutcome.Invalid,
                null
            );
        }

        lock (state.SyncRoot)
        {
            if (!state.Reservations.TryGetValue(id, out var reservation))
            {
                return new AdjustReservationQuantityResult(
                    AdjustReservationQuantityOutcome.NotFound,
                    null
                );
            }

            if (reservation.Status != ReservationStatus.Pending)
            {
                return new AdjustReservationQuantityResult(
                    AdjustReservationQuantityOutcome.NotPending,
                    null
                );
            }

            var available = state.Stock[reservation.Sku];
            var quantityDelta = requestedQuantity - (long)reservation.Quantity;
            if (quantityDelta > available || available - quantityDelta > int.MaxValue)
            {
                return new AdjustReservationQuantityResult(
                    AdjustReservationQuantityOutcome.InsufficientStock,
                    null
                );
            }

            var updated = reservation with { Quantity = requestedQuantity };
            state.Stock[reservation.Sku] = (int)(available - quantityDelta);
            state.Reservations[id] = updated;
            return new AdjustReservationQuantityResult(
                AdjustReservationQuantityOutcome.Adjusted,
                AdjustReservationResponse.From(updated)
            );
        }
    }
}

internal sealed record AdjustReservationQuantityRequest(int Quantity);

internal sealed record AdjustReservationQuantityResult(
    AdjustReservationQuantityOutcome Outcome,
    AdjustReservationResponse? Reservation
);

internal sealed record AdjustReservationResponse(Guid Id, string Sku, int Quantity, string Status)
{
    internal static AdjustReservationResponse From(ReservationRecord reservation) =>
        new(reservation.Id, reservation.Sku, reservation.Quantity, reservation.Status.ToString());
}

internal enum AdjustReservationQuantityOutcome
{
    Adjusted,
    Invalid,
    NotFound,
    NotPending,
    InsufficientStock,
}
