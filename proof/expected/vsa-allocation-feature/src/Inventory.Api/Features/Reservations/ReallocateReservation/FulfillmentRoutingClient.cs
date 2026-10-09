using System.Net.Http.Json;
using System.Text.Json;

namespace Inventory.Api.Features.Reservations.ReallocateReservation;

internal sealed class FulfillmentRoutingClient(HttpClient httpClient)
{
    internal async Task<FulfillmentRoutingResult> GetRoutesAsync(
        string sku,
        string destinationPostalCode,
        CancellationToken cancellationToken
    )
    {
        try
        {
            using var response = await httpClient.PostAsJsonAsync(
                "routes",
                FulfillmentRoutingRequest.FromHttp(sku, destinationPostalCode),
                cancellationToken
            );
            if (!response.IsSuccessStatusCode)
            {
                return new FulfillmentRoutingResult(FulfillmentRoutingOutcome.Failed, null);
            }

            FulfillmentRoutingResponse? payload;
            try
            {
                payload = await response.Content.ReadFromJsonAsync<FulfillmentRoutingResponse>(
                    cancellationToken
                );
            }
            catch (JsonException)
            {
                return new FulfillmentRoutingResult(
                    FulfillmentRoutingOutcome.InvalidResponse,
                    null
                );
            }
            catch (NotSupportedException)
            {
                return new FulfillmentRoutingResult(
                    FulfillmentRoutingOutcome.InvalidResponse,
                    null
                );
            }

            var routes = MapAndValidate(payload);
            return routes is null
                ? new FulfillmentRoutingResult(FulfillmentRoutingOutcome.InvalidResponse, null)
                : new FulfillmentRoutingResult(FulfillmentRoutingOutcome.Succeeded, routes);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new FulfillmentRoutingResult(FulfillmentRoutingOutcome.TimedOut, null);
        }
        catch (HttpRequestException)
        {
            return new FulfillmentRoutingResult(FulfillmentRoutingOutcome.Failed, null);
        }
    }

    private static FulfillmentRoute[]? MapAndValidate(FulfillmentRoutingResponse? payload)
    {
        if (payload?.Routes is null)
        {
            return null;
        }

        var locations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var priorities = new HashSet<int>();
        var mapped = new List<FulfillmentRoute>(payload.Routes.Length);
        foreach (var route in payload.Routes)
        {
            if (route is null || string.IsNullOrWhiteSpace(route.Location) || route.Priority <= 0)
            {
                return null;
            }

            var location = route.Location.Trim().ToUpperInvariant();
            if (!locations.Add(location) || !priorities.Add(route.Priority))
            {
                return null;
            }
            mapped.Add(new FulfillmentRoute(location, route.Priority));
        }

        return mapped
            .OrderBy(route => route.Priority)
            .ThenBy(route => route.Location, StringComparer.Ordinal)
            .ToArray();
    }
}

internal sealed record FulfillmentRoutingRequest(string Sku, string DestinationPostalCode)
{
    internal static FulfillmentRoutingRequest FromHttp(string sku, string destinationPostalCode) =>
        new(sku, destinationPostalCode);
}

internal sealed record FulfillmentRoutingResponse(FulfillmentRoutingRoute?[]? Routes);

internal sealed record FulfillmentRoutingRoute(string? Location, int Priority);

internal sealed record FulfillmentRoute(string Location, int Priority);

internal sealed record FulfillmentRoutingResult(
    FulfillmentRoutingOutcome Outcome,
    FulfillmentRoute[]? Routes
);

internal enum FulfillmentRoutingOutcome
{
    Succeeded,
    Failed,
    InvalidResponse,
    TimedOut,
}
