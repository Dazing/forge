using Inventory.Api.Data;

namespace Inventory.Api.Features.Reservations;

internal static class CancelReservation
{
    internal static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost(
            "/reservations/{id:guid}/cancel",
            (Guid id, InventoryState state) =>
                Execute(id, state) switch
                {
                    CancelReservationOutcome.Succeeded => Results.NoContent(),
                    CancelReservationOutcome.NotFound => Results.NotFound(),
                    CancelReservationOutcome.NotPending => Results.Conflict(),
                    _ => throw new InvalidOperationException("Unknown cancellation outcome."),
                }
        );
    }

    internal static CancelReservationOutcome Execute(Guid id, InventoryState state)
    {
        lock (state.SyncRoot)
        {
            if (!state.Reservations.TryGetValue(id, out var reservation))
            {
                return CancelReservationOutcome.NotFound;
            }

            if (reservation.Status != ReservationStatus.Pending)
            {
                return CancelReservationOutcome.NotPending;
            }

            var available = state.Stock[reservation.Sku];
            state.Stock[reservation.Sku] = checked(available + reservation.Quantity);
            state.Reservations[id] = reservation with { Status = ReservationStatus.Cancelled };
            return CancelReservationOutcome.Succeeded;
        }
    }
}

internal enum CancelReservationOutcome
{
    Succeeded,
    NotFound,
    NotPending,
}
