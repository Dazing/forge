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
                    CancelReservationOutcome.StockOverflow => Results.Conflict(),
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

            var locations = state.Stock[reservation.Sku];
            var restoredAvailable = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var allocation in reservation.Allocations)
            {
                var location = locations[allocation.Location];
                var available = restoredAvailable.GetValueOrDefault(
                    allocation.Location,
                    location.Available
                );
                if (available > int.MaxValue - allocation.Quantity)
                {
                    return CancelReservationOutcome.StockOverflow;
                }
                restoredAvailable[allocation.Location] = available + allocation.Quantity;
            }

            foreach (var (locationName, available) in restoredAvailable)
            {
                locations[locationName] = locations[locationName] with { Available = available };
            }
            state.Reservations[id] = reservation with { Status = ReservationStatus.Cancelled };
            state.Version++;
            return CancelReservationOutcome.Succeeded;
        }
    }
}

internal enum CancelReservationOutcome
{
    Succeeded,
    NotFound,
    NotPending,
    StockOverflow,
}
