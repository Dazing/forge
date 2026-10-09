var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<ReservationStore>();
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapGet(
    "/inventory/{sku}",
    (string sku, ReservationStore store) => Results.Ok(store.Inventory(sku))
);
app.MapPost(
    "/reservations",
    (CreateReservation request, ReservationStore store) =>
        store.TryCreate(request.Sku, request.Quantity, out var reservation)
            ? Results.Created($"/reservations/{reservation!.Id}", reservation)
            : Results.Conflict()
);
app.MapPost(
    "/reservations/{id:guid}/confirm",
    (Guid id, ReservationStore store) =>
        store.Confirm(id) ? Results.NoContent() : Results.Conflict()
);
app.MapPost(
    "/reservations/{id:guid}/cancel",
    (Guid id, ReservationStore store) => store.Cancel(id) ? Results.NoContent() : Results.Conflict()
);
app.Run();

public sealed record CreateReservation(string Sku, int Quantity);

public sealed record StockView(string Sku, int Available);

public sealed record Reservation(Guid Id, string Sku, int Quantity, ReservationStatus Status);

public enum ReservationStatus
{
    Pending,
    Confirmed,
    Cancelled,
}

public sealed class ReservationStore
{
    private readonly object _sync = new();
    private readonly Dictionary<string, int> _stock = new(StringComparer.OrdinalIgnoreCase)
    {
        ["WIDGET"] = 10,
    };
    private readonly Dictionary<Guid, Reservation> _reservations = [];

    public StockView Inventory(string sku)
    {
        lock (_sync)
            return new(sku.ToUpperInvariant(), _stock.GetValueOrDefault(sku));
    }

    public bool TryCreate(string sku, int quantity, out Reservation? reservation)
    {
        lock (_sync)
        {
            if (quantity <= 0 || _stock.GetValueOrDefault(sku) < quantity)
            {
                reservation = null;
                return false;
            }
            _stock[sku] -= quantity;
            reservation = new(
                Guid.NewGuid(),
                sku.ToUpperInvariant(),
                quantity,
                ReservationStatus.Pending
            );
            _reservations.Add(reservation.Id, reservation);
            return true;
        }
    }

    public bool Confirm(Guid id)
    {
        lock (_sync)
        {
            if (
                !_reservations.TryGetValue(id, out var current)
                || current.Status != ReservationStatus.Pending
            )
                return false;
            _reservations[id] = current with { Status = ReservationStatus.Confirmed };
            return true;
        }
    }

    public bool Cancel(Guid id)
    {
        lock (_sync)
        {
            if (
                !_reservations.TryGetValue(id, out var current)
                || current.Status != ReservationStatus.Pending
            )
                return false;
            _stock[current.Sku] = _stock.GetValueOrDefault(current.Sku) + current.Quantity;
            _reservations[id] = current with { Status = ReservationStatus.Cancelled };
            return true;
        }
    }
}
