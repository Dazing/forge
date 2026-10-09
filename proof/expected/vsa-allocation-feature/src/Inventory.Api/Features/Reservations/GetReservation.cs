using Inventory.Api.Data;

namespace Inventory.Api.Features.Reservations;

internal static class GetReservation
{
    internal static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet(
            "/reservations/{id:guid}",
            (Guid id, InventoryState state) =>
            {
                var reservation = Execute(id, state);
                return reservation is null ? Results.NotFound() : Results.Ok(reservation);
            }
        );
    }

    internal static GetReservationResponse? Execute(Guid id, InventoryState state)
    {
        lock (state.SyncRoot)
        {
            return state.Reservations.TryGetValue(id, out var reservation)
                ? GetReservationResponse.From(reservation)
                : null;
        }
    }
}

internal sealed record GetReservationResponse(
    Guid Id,
    string Sku,
    int Quantity,
    string Status,
    GetReservationAllocationResponse[] Allocations
)
{
    internal static GetReservationResponse From(ReservationRecord reservation) =>
        new(
            reservation.Id,
            reservation.Sku,
            reservation.Quantity,
            reservation.Status.ToString(),
            reservation
                .Allocations.Select(allocation => new GetReservationAllocationResponse(
                    allocation.Location,
                    allocation.Quantity
                ))
                .ToArray()
        );
}

internal sealed record GetReservationAllocationResponse(string Location, int Quantity);
