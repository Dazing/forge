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

        var normalizedSku = sku.ToUpperInvariant();
        lock (state.SyncRoot)
        {
            if (!state.Stock.TryGetValue(normalizedSku, out var available))
            {
                return new CreateReservationResult(CreateReservationOutcome.UnknownSku, null);
            }

            if (available < quantity)
            {
                return new CreateReservationResult(
                    CreateReservationOutcome.InsufficientStock,
                    null
                );
            }

            var reservation = new ReservationRecord(
                Guid.NewGuid(),
                normalizedSku,
                quantity,
                ReservationStatus.Pending
            );
            state.Stock[normalizedSku] = available - quantity;
            state.Reservations.Add(reservation.Id, reservation);
            return new CreateReservationResult(
                CreateReservationOutcome.Created,
                ReservationResponse.From(reservation)
            );
        }
    }
}

internal sealed record CreateReservationRequest(string Sku, int Quantity);

internal sealed record CreateReservationResult(
    CreateReservationOutcome Outcome,
    ReservationResponse? Reservation
);

internal enum CreateReservationOutcome
{
    Created,
    Invalid,
    UnknownSku,
    InsufficientStock,
}

internal sealed record ReservationResponse(Guid Id, string Sku, int Quantity, string Status)
{
    internal static ReservationResponse From(ReservationRecord reservation) =>
        new(reservation.Id, reservation.Sku, reservation.Quantity, reservation.Status.ToString());
}
