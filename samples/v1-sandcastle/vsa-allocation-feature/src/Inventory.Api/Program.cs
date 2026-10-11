using Inventory.Api.Data;
using Inventory.Api.Features.Inventory;
using Inventory.Api.Features.Reservations;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<InventoryState>();

var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
GetInventory.Map(app);
ReceiveLocationStock.Map(app);
CreateReservation.Map(app);
GetReservation.Map(app);
ConfirmReservation.Map(app);
CancelReservation.Map(app);
app.Run();
