---
name: inventory-allocation-api
summary: Reviewed allocation and fulfillment-routing contract for the controlled .NET inventory proof repository.
---

# Inventory allocation API standard

Preserve the repository's capability-oriented slices, composition-only `Program.cs`, and storage/synchronization-only `Data` bucket. A slice may reference `Data` and ASP.NET Core but never another slice. Do not add a controller, service layer, repository, mediator, AutoMapper, reflection discovery, database, retry, compatibility shim, generic VSA framework, or package.

## Public reallocation contract

Implement `PUT /reservations/{id:guid}/allocations` with JSON `{ "quantity": <positive integer>, "destinationPostalCode": "<non-blank string>" }`. Success returns `200` and `{ id, sku, quantity, status: "Pending", allocations: [{ location, quantity }] }`. Return `400` before I/O for non-positive quantity or blank postal code, `404` before I/O for an unknown reservation, and `409` before I/O for a confirmed or cancelled reservation. Return mutation-free `409` for insufficient stock or a stale state snapshot, `502` for routing non-success or semantic response failure, and `504` for routing timeout.

## Fulfillment-routing boundary

Use a typed `HttpClient` configured from `FULFILLMENT_ROUTING_BASE_URL`, with a 500 ms timeout and no retries. Send one `POST /routes` request for each syntactically valid pending reservation:

```json
{ "sku": "WIDGET", "destinationPostalCode": "94105" }
```

A valid response has `routes` entries shaped as `{ "location": "south", "priority": 1 }`. At this external boundary, trim and uppercase locations once. Reject a blank location, non-positive priority, duplicate normalized location, duplicate priority, absent/null route list, or invalid JSON as `502`. Order valid routes by priority and then uppercase location. Ignore routed locations that do not exist for the reservation SKU during calculation.

The host-owned deterministic routing service provides:

- `94105`: `SOUTH` priority 1, then `NORTH` priority 2.
- `10001`: `NORTH` priority 1, then `SOUTH` priority 2.
- `60601`: unknown `CENTRAL` priority 1, then `NORTH` priority 2, then `SOUTH` priority 3.
- `50300`: HTTP 503.
- `00000`: HTTP 200 with a semantically malformed route payload.
- `99999`: a response delayed beyond the 500 ms client timeout.

Do not encode these postal-code behaviors in production code; they describe protected host infrastructure only.

## Pure calculation and commit

The calculator receives only requested quantity and route-ordered plain candidates containing physical available stock, safety stock, and this reservation's current allocation. For each known candidate calculate `capacity = physical available + current reservation allocation - safety stock`, clamp it at zero, and allocate greedily by route order. Return a decision only when the whole requested quantity can be satisfied; never return a partially successful decision. The calculator performs no state access, HTTP, locking, logging, or mutation.

For a valid request, lock only to load and snapshot the pending reservation, global version, and relevant location records. Release the lock before outbound HTTP and calculation. Reacquire it to require both the global version and reservation snapshot to match. An unchanged quantity and allocation sequence is a successful `200` no-op without mutation or version increment. Otherwise restore old allocations, consume the complete new decision, replace quantity and allocations, and increment the version exactly once in one critical section. No failure path may mutate reservation or stock state.

External DTOs never enter `InventoryState` or public responses. Persistence records never cross the HTTP boundary. Keep operation methods and calculation types internal; only `Inventory.Tests` receives internal visibility.
