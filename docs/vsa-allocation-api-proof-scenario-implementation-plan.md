# VSA allocation API proof scenario — implementation plan

Status: implemented and deterministically verified on 2026-10-09. The baseline, ticket, protected routing stub, trusted runner integration, oracle, evaluator, preflight, documentation, and verification matrix are complete; the real-model proof remains blocked by the recorded Docker and OpenAI subscription authentication prerequisites.

Authority: [Software Factory POC brief](software-factory-poc-brief.md), [factory implementation plan](software-factory-poc-implementation-plan.md), the implemented [VSA quantity-adjustment scenario](vsa-api-proof-scenario-implementation-plan.md), and the current executable proof harness.

## 1. Outcome and boundaries

Add an independent scenario in which an agent implements **Reallocate a pending reservation across fulfillment locations** in a functioning .NET 10 inventory API. The new slice must combine:

- a pure, deterministic multi-location allocation calculation;
- explicit mapping between HTTP, persistence, calculation, and external-routing representations;
- one outbound fulfillment-routing HTTP dependency;
- optimistic concurrency around that external call;
- atomic in-memory commit or mutation-free failure;
- observable rollback and conservation behavior.

The scenario is additive. It does not replace or alter the existing six scenarios. It remains one ASP.NET Core API process with deterministic in-memory state, no authentication, database, mediator, repository layer, generic VSA framework, retry policy, or new NuGet package. The only network dependency is a loopback fulfillment-routing API owned by the host-side acceptance runner or independent evaluator.

## 2. Integration decision

Create:

- `samples/vsa-allocation-feature/**` — fixed location-aware baseline with six working business slices and no reallocation endpoint;
- `samples/tickets/vsa-allocation-feature.md` — the reallocation ticket and seven stable criteria;
- `standards/skills/inventory-allocation-api/SKILL.md` — routing contract, deterministic acceptance-stub behaviors, mapping rules, and architecture constraints;
- `proof/scenarios/vsa-allocation-feature.json`;
- `proof/expected/vsa-allocation-feature/**` — manually reviewed oracle;
- `proof/evaluators/vsa-allocation-feature.sh` and a distinct mode in `api_evaluator.py`;
- `proof/harness/fulfillment_routing_stub.py` — host-owned deterministic loopback stub shared by trusted acceptance and the evaluator.

Extend, rather than duplicate:

- `proof/harness/trusted_acceptance.py` to start the routing stub per case, pass its ephemeral URL as `FULFILLMENT_ROUTING_BASE_URL`, and support numeric dotted paths such as `allocations.0.location`;
- `tests/integration/preflight.test.ts` with a baseline intentional-RED case;
- existing documentation loops and matrices.

Do not change the proof scenario schema, fixture materializer, factory orchestration, repository profile, trusted verification contracts, or package dependencies.

## 3. Architecture and ownership

The fixture retains four explicit buckets:

- **Slices:** one capability per file under `Features/Inventory` or `Features/Reservations`. The dense ticketed capability owns a subfolder because it has an HTTP endpoint, pure calculator, external client, and boundary DTOs.
- **Composition root:** `Program.cs` creates `InventoryState`, maps baseline slices, and, in the solution, registers/configures the routing client and maps the reallocation slice. It contains no policy.
- **Data:** `Data/InventoryState.cs` owns the lock, monotonically increasing version, seeded location stock, reservations, allocations, and persistence-shaped records only.
- **Host-owned test infrastructure:** the routing stub remains outside materialized repositories and is never available for agent modification.

Mechanical rules:

1. A slice may use `Data` and ASP.NET Core but must not reference another slice.
2. `Data` must not reference `Features` or contain routing, allocation, quantity, transition, or HTTP policy.
3. External DTOs never enter `InventoryState` or HTTP responses.
4. Persistence records never cross the public HTTP boundary.
5. No lock may be held during outbound HTTP.
6. Every multi-record stock/reservation commit occurs under the one state lock.
7. No controllers, services layer, repositories, MediatR, AutoMapper, reflection discovery, retry library, or new package.
8. Operation methods and calculation types remain `internal`; only `Inventory.Tests` receives internals access.

## 4. Baseline application

### 4.1 State model

Seed SKU `WIDGET` at two locations:

| Location | Available physical stock | Safety stock | Allocatable |
|---|---:|---:|---:|
| `NORTH` | 10 | 2 | 8 |
| `SOUTH` | 8 | 1 | 7 |

`InventoryState` contains:

- one synchronization object;
- a case-insensitive SKU map containing case-insensitive location maps;
- GUID-keyed reservations;
- a `long Version` incremented once by every successful write operation.

Persistence-shaped records:

- `LocationStockRecord(Sku, Location, Available, SafetyStock)`;
- `ReservationRecord(Id, Sku, Quantity, Status, ReservationAllocationRecord[] Allocations)`;
- `ReservationAllocationRecord(Location, Quantity)`;
- `ReservationStatus` with `Pending`, `Confirmed`, and `Cancelled`.

Available physical stock is decremented when allocated and restored on cancellation. A slice may allocate at most `Available - SafetyStock`; safety stock remains physically present and cannot be reserved.

### 4.2 Six baseline business slices

`GET /health` is readiness plumbing and is not counted.

| Slice | Contract and behavior |
|---|---|
| Get inventory | `GET /inventory/{sku}` returns uppercase SKU, aggregate allocatable quantity, and locations sorted by uppercase location. Unknown SKU is `404`. |
| Receive location stock | `POST /inventory/{sku}/locations/{location}/receipts` with positive `{ quantity }`; creates a location with safety stock zero or increments physical stock atomically. Blank identifiers/non-positive quantity are `400`; overflow is `409`. |
| Create reservation | `POST /reservations` with `{ sku, quantity }`; allocates greedily by uppercase location while preserving safety stock, returns `201` with ordered allocations, and mutates atomically. Invalid is `400`, unknown SKU `404`, insufficient allocatable stock `409`. |
| Get reservation | `GET /reservations/{id:guid}` returns the complete stable representation or `404`. |
| Confirm reservation | Pending to Confirmed, `204`; unknown `404`; terminal `409`; stock unchanged. |
| Cancel reservation | Pending to Cancelled, restores each allocation exactly once under one lock, `204`; unknown `404`; terminal `409`. |

Baseline executable tests directly invoke internal operations and cover case normalization, deterministic allocation, safety stock, receipt validation/overflow, reservation lookup, confirmation, cancellation, transition rejection, version increments, and conservation. They test decisions and state, not route wiring or source text.

## 5. Ticketed slice

### 5.1 Public contract

Add:

```http
PUT /reservations/{id:guid}/allocations
Content-Type: application/json

{
  "quantity": 10,
  "destinationPostalCode": "94105"
}
```

Success is `200`:

```json
{
  "id": "<guid>",
  "sku": "WIDGET",
  "quantity": 10,
  "status": "Pending",
  "allocations": [
    { "location": "SOUTH", "quantity": 7 },
    { "location": "NORTH", "quantity": 3 }
  ]
}
```

Outcome rules:

| Condition | Status | Mutation |
|---|---:|---|
| Positive quantity, pending reservation, valid routing response, enough allocatable stock | `200` | Replace allocations and quantity atomically; stock changes only by releasing old allocations and consuming new allocations. |
| Same quantity and same calculated allocations | `200` | Successful no-op representation; no state-version increment. |
| Quantity `<= 0` or blank postal code | `400` | None; routing API is not called. |
| Unknown reservation | `404` | None; routing API is not called. |
| Confirmed or Cancelled reservation | `409` | None; routing API is not called. |
| Valid routing response but insufficient stock after virtually releasing current allocations | `409` | None. |
| State version changed while routing was in flight | `409` | None; caller may submit a fresh request. |
| Routing non-success or malformed semantic payload | `502` | None. |
| Routing timeout | `504` | None. |

### 5.2 External routing contract

The solution sends:

```http
POST {FULFILLMENT_ROUTING_BASE_URL}/routes
Content-Type: application/json

{
  "sku": "WIDGET",
  "destinationPostalCode": "94105"
}
```

A valid response is:

```json
{
  "routes": [
    { "location": "south", "priority": 1 },
    { "location": "north", "priority": 2 }
  ]
}
```

Mapping rules:

- trim and uppercase locations once at the external boundary;
- reject blank locations, non-positive priorities, duplicate locations, or duplicate priorities as `502`;
- ignore valid routed locations that do not exist for the SKU when calculating;
- order by priority, then uppercase location for deterministic ties (ties are rejected, but the calculator remains deterministic);
- configure the typed `HttpClient` from `FULFILLMENT_ROUTING_BASE_URL` with a 500 ms timeout;
- do not retry.

The host-owned stub uses these deterministic postal codes:

| Postal code | Behavior |
|---|---|
| `94105` | `SOUTH` priority 1, `NORTH` priority 2 |
| `10001` | `NORTH` priority 1, `SOUTH` priority 2 |
| `60601` | valid route containing unknown `CENTRAL`, followed by `NORTH`, then `SOUTH` |
| `50300` | HTTP `503` |
| `00000` | HTTP `200` with a semantically malformed routing payload |
| `99999` | response delayed beyond the API client timeout |

### 5.3 Pure allocation calculation

`AllocationCalculator` receives only plain values:

- requested quantity;
- route-ordered location candidates;
- each candidate's physical available stock, safety stock, and currently allocated quantity for this reservation.

It virtually releases the reservation's current allocation before calculating candidate capacity:

```text
capacity = current physical available + current reservation allocation - safety stock
```

For each routed, known location in priority order, allocate `min(remaining, max(0, capacity))`. Return an ordered allocation decision only when the complete requested quantity can be satisfied. Never return a partial successful decision.

The calculator performs no state access, HTTP, logging, locking, or mutation.

### 5.4 Optimistic operation

The handler/operation sequence is fixed:

1. Validate request syntax.
2. Lock state; load reservation and reject unknown/terminal state.
3. Snapshot state version, reservation, and relevant location stock values; release lock.
4. Call routing API with request cancellation.
5. Map and validate the external payload.
6. Run the pure calculator.
7. Reacquire lock.
8. Require the global state version and reservation snapshot to still match.
9. If the decision is unchanged, return the current representation without mutation/version increment.
10. Otherwise restore old allocations, consume new allocations, replace reservation quantity/allocations, increment version once, and return the mapped response.

No failure path changes either stock or reservation state.

### 5.5 Ticket criteria

- **INV-ALLOC-001:** Reallocation follows routing priority, respects safety stock, returns deterministic mapped allocations, and changes stock only by the old/new allocation delta.
- **INV-ALLOC-002:** Reallocation can increase or decrease quantity; subsequent confirmation keeps the final allocation consumed and cancellation restores the final allocation exactly once.
- **INV-ALLOC-003:** Insufficient allocatable stock returns `409` with reservation, location stock, and version unchanged.
- **INV-ALLOC-004:** Non-positive quantity, blank postal code, unknown reservation, and terminal reservation return their specified statuses without calling routing or mutating state.
- **INV-ALLOC-005:** Routing non-success, malformed payload, and timeout map to `502`, `502`, and `504` respectively with no mutation.
- **INV-ALLOC-006:** A concurrent state change detected after routing returns `409` and does not apply a stale allocation decision.
- **INV-ALLOC-007:** Existing inventory receipt, creation, lookup, confirmation, cancellation, case normalization, safety-stock, and conservation behavior remains intact.

## 6. Solution layout

```text
samples/vsa-allocation-feature/
  AGENTS.md
  src/Inventory.Api/
    Inventory.Api.csproj
    Program.cs
    Properties/AssemblyInfo.cs
    Data/InventoryState.cs
    Features/Inventory/
      GetInventory.cs
      ReceiveLocationStock.cs
    Features/Reservations/
      CreateReservation.cs
      GetReservation.cs
      ConfirmReservation.cs
      CancelReservation.cs
      # ReallocateReservation/ absent from baseline
  tests/Inventory.Tests/
    Inventory.Tests.csproj
    Program.cs
proof/expected/vsa-allocation-feature/
  # baseline plus:
  src/Inventory.Api/Features/Reservations/ReallocateReservation/
    ReallocateReservation.cs
    AllocationCalculator.cs
    FulfillmentRoutingClient.cs
    ReallocationDtos.cs
proof/harness/
  fulfillment_routing_stub.py
```

The oracle differs from the baseline only by the ticketed subfolder, composition-root registration/mapping, focused tests, and completed-behavior instructions.

## 7. Trusted acceptance and harness changes

### 7.1 Generic runner additions

`fulfillment_routing_stub.py` exposes a context manager that starts `ThreadingHTTPServer` on an ephemeral loopback port and shuts it down reliably. Both `trusted_acceptance.py` and `api_evaluator.py` import it; no stub code enters a materialized repository.

For every declarative case, `trusted_acceptance.py`:

1. starts a fresh routing stub;
2. adds `FULFILLMENT_ROUTING_BASE_URL` to the child API environment;
3. starts the API as today;
4. executes the case;
5. terminates the API and stub on success, assertion failure, readiness failure, or timeout.

`value_at` gains list-index traversal when a dotted path component is a non-negative decimal index. Invalid indices remain assertion failures. Existing dictionary traversal and `${reservationId}` behavior remain unchanged.

These are generic protected-runner capabilities. No scenario-specific pass condition is embedded in the runner.

### 7.2 Minimum authoritative cases

| Candidate case | Core observations |
|---|---|
| `south_first_reallocation` | Create 6, reallocate to 10 using `94105`; assert ordered allocation entries and location/aggregate stock deltas. |
| `decrease_then_confirm` | Reallocate downward using `10001`, confirm, reject cancellation, and verify final quantity remains consumed. |
| `increase_then_cancel` | Reallocate upward, cancel, and verify the final allocations restore exactly once. |
| `insufficient_rolls_back` | Request beyond total allocatable capacity; assert `409`, unchanged reservation through GET, and unchanged inventory. |
| `invalid_and_terminal_short_circuit` | Invalid quantity/postal, unknown ID, confirmed and cancelled IDs; assert statuses and state. |
| `routing_failures_roll_back` | Separate fresh cases for `50300`, `00000`, and `99999`; assert `502`, `502`, and `504` plus unchanged reservation/inventory. |
| `existing_slices` | Receipt with mixed case, create, lookup, confirm/cancel, and conservation. |

The declarative runner remains sequential. Stale-snapshot concurrency is tested by local operation tests and the independent evaluator.

Expected RED: the baseline builds/tests, candidate tests are discovered, and the first reallocation request fails by HTTP assertion because the route is absent. Stub startup or application infrastructure failure is not valid RED.

## 8. Independent evaluator

`proof/evaluators/vsa-allocation-feature.sh` delegates to `api_evaluator.py vsa-allocation-feature <repository>`. The evaluator starts the shared routing stub before the API and passes its URL through the environment.

Required checks:

1. Exercise all six baseline slices before the missing/new endpoint check.
2. Verify south-first and north-first calculations with quantities different from ticket examples.
3. Verify unknown routed locations are ignored without disturbing deterministic order.
4. Verify increase, decrease, same-decision no-op, confirmation, and cancellation conservation.
5. Verify insufficient capacity rollback through reservation GET and inventory reads.
6. Verify invalid/unknown/terminal requests short-circuit without observable state changes.
7. Verify routing `503`, malformed payload, and timeout status translation with rollback.
8. Force a state change while a delayed routing call is in flight; require stale request `409`, preserve the concurrent write, and prove conservation.
9. Send concurrent reallocations sharing location stock; require only a conservation-safe set of successes and final allocatable stock never below zero.

Baseline contract: evaluator reaches the first reallocation request only after baseline checks, receives `404`, and exits nonzero for that assertion. Oracle contract: all checks exit zero. Existing evaluator modes must remain green.

## 9. Ordered implementation phases

1. **Baseline:** build the location-aware state and six slices with executable tests; smoke all HTTP behavior; confirm reallocation is `404`.
2. **Ticket and standard:** add seven criteria and the routing/stub contract; bind the new scenario.
3. **Protected stub and runner:** implement lifecycle-safe loopback routing stub, environment injection, and numeric list paths; add focused runner coverage and preserve existing preflight behavior.
4. **Oracle:** add tests first, then calculator, explicit mappings, typed HTTP client, optimistic operation, and composition wiring.
5. **Evaluator:** add external failure, timeout, stale-snapshot, concurrent conservation, and baseline-fail/oracle-pass checks.
6. **Integration:** add preflight RED, README/runbook loops, fixture matrix, implementation-plan amendment, and only observed verification evidence.
7. **Verification:** run the matrix below, remove generated outputs and temporary repositories, and run a real proof only when Docker and OpenAI subscription authentication prerequisites exist.

## 10. Verification matrix

| Scope | Command | Expected |
|---|---|---|
| Baseline | `dotnet build samples/vsa-allocation-feature/src/Inventory.Api/Inventory.Api.csproj --nologo && dotnet run --project samples/vsa-allocation-feature/tests/Inventory.Tests/Inventory.Tests.csproj` | Exit 0, no warnings, six-slice checks pass. |
| Oracle | `dotnet build proof/expected/vsa-allocation-feature/src/Inventory.Api/Inventory.Api.csproj --nologo && dotnet run --project proof/expected/vsa-allocation-feature/tests/Inventory.Tests/Inventory.Tests.csproj` | Exit 0, calculation/mapping/failure/stale-state tests pass. |
| Materialization | `npx tsx proof/harness/materialize-fixture.ts proof/scenarios/vsa-allocation-feature.json /tmp/factory-vsa-allocation-feature` | Clean `main`, no reallocation subfolder or generated outputs. |
| Baseline evaluator | `proof/evaluators/vsa-allocation-feature.sh samples/vsa-allocation-feature` | Expected nonzero at missing reallocation route after baseline checks. |
| Oracle evaluator | `proof/evaluators/vsa-allocation-feature.sh proof/expected/vsa-allocation-feature` | Exit 0 for calculation, mapping, upstream failures, timeout, stale state, and concurrency. |
| Existing evaluator regression | `proof/evaluators/feature.sh proof/expected/feature && proof/evaluators/bug.sh proof/expected/bug && proof/evaluators/refactor.sh proof/expected/refactor && proof/evaluators/vsa-feature.sh proof/expected/vsa-feature` | Exit 0. |
| Focused integration | `npm test -- --run tests/integration/preflight.test.ts` | Existing cases plus allocation intentional RED pass. |
| Full deterministic suite | `npm run check` | Typecheck, dependency checks, and all tests pass. |
| Fixture matrix | `for fixture in feature bug refactor recovery-success recovery-exhaustion vsa-feature vsa-allocation-feature; do dotnet build "samples/$fixture/src/Inventory.Api/Inventory.Api.csproj" --nologo && dotnet run --project "samples/$fixture/tests/Inventory.Tests/Inventory.Tests.csproj"; done` | All seven baselines pass independently. |
| Real proof | `PROOF_ID="$(date +%s)"; npx tsx proof/harness/run-proof.ts config/factory.local.json proof/scenarios/vsa-allocation-feature.json "factory/proof-vsa-allocation-feature-$PROOF_ID" "$PROOF_ID-vsa-allocation-feature"` | With prerequisites: succeeded branch and evaluator. Without Docker/authentication: exact blocker, no success claim. |

## 11. Risks and fixed decisions

| Item | Decision or treatment |
|---|---|
| External API makes acceptance nondeterministic | Only host-owned ephemeral loopback stubs are used; no internet or fixed port. |
| Lock across HTTP can serialize or deadlock | Forbidden; snapshot/call/compare/commit sequence is mandatory. |
| Optimistic conflict can be over-broad | One global version is intentionally conservative for this compact fixture. |
| Retry semantics obscure the target | No retries. One outbound attempt per valid request. |
| Mapping abstraction becomes a shared layer | Manual mapping remains inside the ticketed slice. No AutoMapper or generic mapper. |
| Calculator becomes stateful | Plain input/output values only; no state, HTTP, lock, or framework dependency. |
| Stub knowledge leaks into production | Stub postal codes live in the supplied scenario standard and host harness, never in API production branches. |
| Runner change regresses existing scenarios | Stub startup is transparent; rerun every existing preflight and evaluator mode. |
| Real model/container unavailable | Complete deterministic work and record real proof as `BLOCKED`; never substitute oracle evidence. |

No product decision remains open. Any implementation deviation that changes endpoint shape, statuses, calculation order, routing mapping, optimistic concurrency, trust boundary, or scenario independence must update this plan before code changes.
