using Inventory.Api.Data;

namespace Inventory.Api.Features.Reservations.ReallocateReservation;

internal sealed record ReallocateReservationRequest(int Quantity, string DestinationPostalCode);

internal sealed record ReallocateReservationResponse(
    Guid Id,
    string Sku,
    int Quantity,
    string Status,
    ReallocationResponseAllocation[] Allocations
)
{
    internal static ReallocateReservationResponse FromPersistence(ReservationRecord reservation) =>
        new(
            reservation.Id,
            reservation.Sku,
            reservation.Quantity,
            reservation.Status.ToString(),
            reservation
                .Allocations.Select(allocation => new ReallocationResponseAllocation(
                    allocation.Location,
                    allocation.Quantity
                ))
                .ToArray()
        );
}

internal sealed record ReallocationResponseAllocation(string Location, int Quantity);
