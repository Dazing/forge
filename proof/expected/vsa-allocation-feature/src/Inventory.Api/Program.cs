using Inventory.Api.Data;
using Inventory.Api.Features.Inventory;
using Inventory.Api.Features.Reservations;
using Inventory.Api.Features.Reservations.ReallocateReservation;

var builder = WebApplication.CreateBuilder(args);
var routingBaseUrl = builder.Configuration["FULFILLMENT_ROUTING_BASE_URL"];
if (
    string.IsNullOrWhiteSpace(routingBaseUrl)
    || !Uri.TryCreate(routingBaseUrl.TrimEnd('/') + "/", UriKind.Absolute, out var routingUri)
)
{
    throw new InvalidOperationException(
        "FULFILLMENT_ROUTING_BASE_URL must be an absolute routing service URL."
    );
}

builder.Services.AddSingleton<InventoryState>();
builder.Services.AddHttpClient<FulfillmentRoutingClient>(client =>
{
    client.BaseAddress = routingUri;
    client.Timeout = TimeSpan.FromMilliseconds(500);
});

var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
GetInventory.Map(app);
ReceiveLocationStock.Map(app);
CreateReservation.Map(app);
GetReservation.Map(app);
ConfirmReservation.Map(app);
CancelReservation.Map(app);
ReallocateReservation.Map(app);
app.Run();
