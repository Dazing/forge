using Inventory.Api.Data;

namespace Inventory.Api.Features.Reservations;

internal static class ConfirmReservation
{
    internal static void Map(IEndpointRouteBuilder app)
    {
        app.MapPost(
            "/reservations/{id:guid}/confirm",
            (Guid id, InventoryState state) =>
                Execute(id, state) switch
                {
                    ConfirmReservationOutcome.Succeeded => Results.NoContent(),
                    ConfirmReservationOutcome.NotFound => Results.NotFound(),
                    ConfirmReservationOutcome.NotPending => Results.Conflict(),
                    _ => throw new InvalidOperationException("Unknown confirmation outcome."),
                }
        );
    }

    internal static ConfirmReservationOutcome Execute(Guid id, InventoryState state)
    {
        lock (state.SyncRoot)
        {
            if (!state.Reservations.TryGetValue(id, out var reservation))
            {
                return ConfirmReservationOutcome.NotFound;
            }

            if (reservation.Status != ReservationStatus.Pending)
            {
                return ConfirmReservationOutcome.NotPending;
            }

            state.Reservations[id] = reservation with { Status = ReservationStatus.Confirmed };
            state.Version++;
            return ConfirmReservationOutcome.Succeeded;
        }
    }
}

internal enum ConfirmReservationOutcome
{
    Succeeded,
    NotFound,
    NotPending,
}
