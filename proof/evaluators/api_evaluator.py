#!/usr/bin/env python3
import concurrent.futures
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import nullcontext


sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "harness")))
from fulfillment_routing_stub import fulfillment_routing_stub  # noqa: E402

mode, repository = sys.argv[1], os.path.abspath(sys.argv[2])
project = os.path.join(repository, "src", "Inventory.Api", "Inventory.Api.csproj")
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]


def request(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = None
        return error.code, payload


def inventory_quantity(path):
    status, payload = request("GET", path)
    assert status == 200, f"inventory lookup returned {status}"
    assert isinstance(payload, dict), "inventory lookup did not return a JSON object"
    if "quantity" in payload:
        return payload["quantity"]
    if "available" in payload:
        return payload["available"]
    raise AssertionError("inventory response exposed neither quantity nor available stock")


def assert_rejected(status, operation):
    assert 400 <= status < 500, (
        f"{operation} returned {status}, expected an explicit 4xx rejection"
    )


def inventory(sku):
    status, body = request("GET", f"/inventory/{sku}")
    assert status == 200, f"inventory lookup for {sku} returned {status}"
    return body["available"]


def receive(sku, quantity):
    status, body = request("POST", f"/inventory/{sku}/receipts", {"quantity": quantity})
    assert status == 200, f"receipt for {sku} returned {status}"
    assert body == {"sku": sku.upper(), "available": quantity}, f"receipt returned {body}"


def create(sku, quantity):
    status, body = request("POST", "/reservations", {"sku": sku, "quantity": quantity})
    assert status == 201, f"creation for {sku} returned {status}"
    assert body["sku"] == sku.upper() and body["quantity"] == quantity and body["status"] == "Pending", f"creation returned {body}"
    return body


def patch(reservation_id, quantity):
    return request("PATCH", f"/reservations/{reservation_id}", {"quantity": quantity})


def evaluate_vsa_feature():
    receive("baseline", 12)
    assert inventory("BASELINE") == 12
    confirmed = create("BASEline", 3)
    assert request("POST", f"/reservations/{confirmed['id']}/confirm")[0] == 204
    assert inventory("baseline") == 9
    cancelled = create("baseline", 2)
    assert request("POST", f"/reservations/{cancelled['id']}/cancel")[0] == 204
    assert inventory("baseline") == 9

    receive("increase", 13)
    increased = create("increase", 4)
    status, body = patch(increased["id"], 7)
    assert status == 200, f"increase returned {status}"
    assert body == {**increased, "quantity": 7}, f"increase returned {body}"
    assert inventory("increase") == 6
    assert request("POST", f"/reservations/{increased['id']}/cancel")[0] == 204
    assert inventory("increase") == 13

    receive("decrease", 15)
    decreased = create("decrease", 8)
    status, body = patch(decreased["id"], 3)
    assert status == 200 and body["quantity"] == 3, f"decrease returned {status}, {body}"
    assert inventory("decrease") == 12
    assert request("POST", f"/reservations/{decreased['id']}/confirm")[0] == 204
    assert request("POST", f"/reservations/{decreased['id']}/cancel")[0] == 409
    assert inventory("decrease") == 12

    receive("same", 9)
    unchanged = create("same", 4)
    status, body = patch(unchanged["id"], 4)
    assert status == 200 and body == unchanged, f"same-value adjustment returned {status}, {body}"
    assert inventory("same") == 5
    assert request("POST", f"/reservations/{unchanged['id']}/cancel")[0] == 204
    assert inventory("same") == 9

    receive("rollback", 10)
    rolled_back = create("rollback", 4)
    assert patch(rolled_back["id"], 11)[0] == 409
    assert inventory("rollback") == 6
    assert request("POST", f"/reservations/{rolled_back['id']}/cancel")[0] == 204
    assert inventory("rollback") == 10

    receive("invalid", 10)
    invalid = create("invalid", 4)
    assert patch(invalid["id"], 0)[0] == 400
    assert patch(invalid["id"], -2)[0] == 400
    assert inventory("invalid") == 6
    assert request("POST", f"/reservations/{invalid['id']}/cancel")[0] == 204
    assert inventory("invalid") == 10

    receive("terminal", 20)
    terminal_confirmed = create("terminal", 3)
    assert request("POST", f"/reservations/{terminal_confirmed['id']}/confirm")[0] == 204
    assert patch(terminal_confirmed["id"], 2)[0] == 409
    terminal_cancelled = create("terminal", 4)
    assert request("POST", f"/reservations/{terminal_cancelled['id']}/cancel")[0] == 204
    assert patch(terminal_cancelled["id"], 2)[0] == 409
    assert patch("00000000-0000-0000-0000-000000000001", 2)[0] == 404
    assert inventory("terminal") == 17

    receive("concurrent", 10)
    first = create("concurrent", 2)
    second = create("concurrent", 2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(patch, first["id"], 6),
            executor.submit(patch, second["id"], 6),
        ]
        results = [future.result(timeout=10) for future in futures]
    statuses = sorted(status for status, _ in results)
    assert statuses == [200, 409], f"competing increases returned {statuses}"
    available = inventory("concurrent")
    assert available == 2, f"competing increases left available={available}"
    assert request("POST", f"/reservations/{first['id']}/cancel")[0] == 204
    assert request("POST", f"/reservations/{second['id']}/cancel")[0] == 204
    assert inventory("concurrent") == 10


def allocation_inventory(sku):
    status, body = request("GET", f"/inventory/{urllib.parse.quote(sku, safe='')}")
    assert status == 200, f"location inventory lookup for {sku} returned {status}"
    return body


def allocation_receive(sku, location, quantity):
    encoded_sku = urllib.parse.quote(sku, safe="")
    encoded_location = urllib.parse.quote(location, safe="")
    status, body = request(
        "POST",
        f"/inventory/{encoded_sku}/locations/{encoded_location}/receipts",
        {"quantity": quantity},
    )
    assert status == 200, f"location receipt for {sku}/{location} returned {status}"
    assert body["sku"] == sku.strip().upper(), f"location receipt returned {body}"
    assert body["location"] == location.strip().upper(), f"location receipt returned {body}"
    return body


def allocation_create(sku, quantity):
    status, body = request("POST", "/reservations", {"sku": sku, "quantity": quantity})
    assert status == 201, f"location reservation creation for {sku} returned {status}"
    assert body["sku"] == sku.strip().upper() and body["quantity"] == quantity
    assert body["status"] == "Pending" and body["allocations"], f"creation returned {body}"
    return body


def allocation_get(reservation_id):
    status, body = request("GET", f"/reservations/{reservation_id}")
    assert status == 200, f"reservation lookup returned {status}"
    return body


def reallocate(reservation_id, quantity, postal_code):
    return request(
        "PUT",
        f"/reservations/{reservation_id}/allocations",
        {"quantity": quantity, "destinationPostalCode": postal_code},
    )


def seed_locations(sku, north, south):
    allocation_receive(sku, "north", north)
    allocation_receive(sku, "south", south)


def assert_unchanged(reservation_id, reservation_before, inventory_before, message):
    assert allocation_get(reservation_id) == reservation_before, f"{message}: reservation changed"
    assert allocation_inventory(reservation_before["sku"]) == inventory_before, f"{message}: inventory changed"


def evaluate_vsa_allocation(routing_stub):
    initial = allocation_inventory("widget")
    assert initial["sku"] == "WIDGET" and initial["available"] == 15
    assert [location["location"] for location in initial["locations"]] == ["NORTH", "SOUTH"]
    assert initial["locations"][0] == {
        "location": "NORTH",
        "available": 10,
        "safetyStock": 2,
        "allocatable": 8,
    }
    assert initial["locations"][1]["safetyStock"] == 1

    allocation_receive(" baseLine ", " west ", 9)
    confirmed = allocation_create("baseline", 3)
    assert allocation_get(confirmed["id"]) == confirmed
    assert request("POST", f"/reservations/{confirmed['id']}/confirm")[0] == 204
    cancelled = allocation_create("BASELINE", 2)
    assert request("POST", f"/reservations/{cancelled['id']}/cancel")[0] == 204
    assert request("POST", f"/reservations/{cancelled['id']}/cancel")[0] == 409
    assert allocation_inventory("baseline")["available"] == 6

    south_first = allocation_create("widget", 4)
    status, body = reallocate(south_first["id"], 9, "94105")
    assert status == 200, f"south-first reallocation returned {status}"
    assert body["quantity"] == 9 and body["status"] == "Pending"
    assert body["allocations"] == [
        {"location": "SOUTH", "quantity": 7},
        {"location": "NORTH", "quantity": 2},
    ], f"south-first reallocation returned {body}"
    outbound = routing_stub.requests[-1]
    assert outbound.sku == "WIDGET" and outbound.destination_postal_code == "94105"
    assert allocation_inventory("widget")["available"] == 6
    assert request("POST", f"/reservations/{south_first['id']}/cancel")[0] == 204
    assert allocation_inventory("widget")["available"] == 15

    seed_locations("northfirst", 8, 7)
    north_first = allocation_create("northfirst", 5)
    status, body = reallocate(north_first["id"], 11, "10001")
    assert status == 200 and body["allocations"] == [
        {"location": "NORTH", "quantity": 8},
        {"location": "SOUTH", "quantity": 3},
    ], f"north-first reallocation returned {status}, {body}"
    outbound = routing_stub.requests[-1]
    assert outbound.sku == "NORTHFIRST" and outbound.destination_postal_code == "10001"
    assert allocation_inventory("northfirst")["available"] == 4
    assert request("POST", f"/reservations/{north_first['id']}/confirm")[0] == 204
    assert request("POST", f"/reservations/{north_first['id']}/cancel")[0] == 409

    seed_locations("unknownroute", 10, 10)
    unknown_route = allocation_create("unknownroute", 4)
    status, body = reallocate(unknown_route["id"], 12, "60601")
    assert status == 200 and body["allocations"] == [
        {"location": "NORTH", "quantity": 10},
        {"location": "SOUTH", "quantity": 2},
    ], f"unknown routed location disturbed order: {status}, {body}"
    assert request("POST", f"/reservations/{unknown_route['id']}/cancel")[0] == 204
    assert allocation_inventory("unknownroute")["available"] == 20

    seed_locations("decrease", 9, 9)
    decreased = allocation_create("decrease", 10)
    status, body = reallocate(decreased["id"], 3, "10001")
    assert status == 200 and body["quantity"] == 3
    assert body["allocations"] == [{"location": "NORTH", "quantity": 3}]
    assert allocation_inventory("decrease")["available"] == 15
    assert request("POST", f"/reservations/{decreased['id']}/confirm")[0] == 204
    assert request("POST", f"/reservations/{decreased['id']}/cancel")[0] == 409
    assert allocation_inventory("decrease")["available"] == 15

    seed_locations("sameallocation", 8, 8)
    unchanged = allocation_create("sameallocation", 6)
    inventory_before = allocation_inventory("sameallocation")
    status, body = reallocate(unchanged["id"], 6, "10001")
    assert status == 200 and body == unchanged, f"same decision returned {status}, {body}"
    assert allocation_inventory("sameallocation") == inventory_before
    assert request("POST", f"/reservations/{unchanged['id']}/cancel")[0] == 204
    assert allocation_inventory("sameallocation")["available"] == 16

    seed_locations("rollback", 6, 5)
    rolled_back = allocation_create("rollback", 4)
    reservation_before = allocation_get(rolled_back["id"])
    inventory_before = allocation_inventory("rollback")
    assert reallocate(rolled_back["id"], 12, "94105")[0] == 409
    assert_unchanged(rolled_back["id"], reservation_before, inventory_before, "insufficient capacity")

    seed_locations("shortcircuit", 10, 10)
    pending = allocation_create("shortcircuit", 4)
    calls_before = routing_stub.request_count
    pending_before = allocation_get(pending["id"])
    inventory_before = allocation_inventory("shortcircuit")
    assert reallocate(pending["id"], 0, "94105")[0] == 400
    assert reallocate(pending["id"], 5, " ")[0] == 400
    assert reallocate("00000000-0000-0000-0000-000000000001", 5, "94105")[0] == 404
    assert routing_stub.request_count == calls_before, "invalid or unknown request called routing"
    assert_unchanged(pending["id"], pending_before, inventory_before, "short-circuit rejection")

    assert request("POST", f"/reservations/{pending['id']}/confirm")[0] == 204
    confirmed_before = allocation_get(pending["id"])
    confirmed_inventory = allocation_inventory("shortcircuit")
    assert reallocate(pending["id"], 5, "94105")[0] == 409
    cancelled_terminal = allocation_create("shortcircuit", 3)
    assert request("POST", f"/reservations/{cancelled_terminal['id']}/cancel")[0] == 204
    cancelled_before = allocation_get(cancelled_terminal["id"])
    assert reallocate(cancelled_terminal["id"], 5, "94105")[0] == 409
    assert routing_stub.request_count == calls_before, "terminal request called routing"
    assert allocation_get(pending["id"]) == confirmed_before
    assert allocation_get(cancelled_terminal["id"]) == cancelled_before
    assert allocation_inventory("shortcircuit") == confirmed_inventory

    for index, (postal_code, expected_status) in enumerate(
        [("50300", 502), ("00000", 502), ("99999", 504)]
    ):
        sku = f"routingfailure{index}"
        seed_locations(sku, 9, 9)
        reservation = allocation_create(sku, 4)
        reservation_before = allocation_get(reservation["id"])
        inventory_before = allocation_inventory(sku)
        status, _ = reallocate(reservation["id"], 7, postal_code)
        assert status == expected_status, f"routing {postal_code} returned {status}"
        assert_unchanged(reservation["id"], reservation_before, inventory_before, f"routing {postal_code}")

    seed_locations("stale", 10, 10)
    stale = allocation_create("stale", 4)
    stale_before = allocation_get(stale["id"])
    stale_requests = routing_stub.request_count_for("94105") + 1
    routing_stub.block("94105")
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(reallocate, stale["id"], 8, "94105")
        assert routing_stub.wait_for_requests("94105", stale_requests), "stale request did not reach routing"
        allocation_receive("stale", "south", 1)
        routing_stub.release("94105")
        status, _ = future.result(timeout=5)
    assert status == 409, f"stale reallocation returned {status}"
    assert allocation_get(stale["id"]) == stale_before
    assert allocation_inventory("stale")["available"] == 17, "concurrent receipt was not preserved"
    assert request("POST", f"/reservations/{stale['id']}/cancel")[0] == 204
    assert allocation_inventory("stale")["available"] == 21

    seed_locations("compete", 8, 7)
    first = allocation_create("compete", 2)
    second = allocation_create("compete", 2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(reallocate, first["id"], 10, "94105"),
            executor.submit(reallocate, second["id"], 10, "94105"),
        ]
        results = [future.result(timeout=10) for future in futures]
    statuses = sorted(status for status, _ in results)
    assert statuses == [200, 409], f"competing reallocations returned {statuses}"
    final_inventory = allocation_inventory("compete")
    assert final_inventory["available"] == 3, f"competing reallocations left {final_inventory}"
    assert all(location["allocatable"] >= 0 for location in final_inventory["locations"])
    assert request("POST", f"/reservations/{first['id']}/cancel")[0] == 204
    assert request("POST", f"/reservations/{second['id']}/cancel")[0] == 204
    assert allocation_inventory("compete")["available"] == 15


routing_context = fulfillment_routing_stub() if mode == "vsa-allocation-feature" else nullcontext(None)
process = None
with routing_context as routing_stub:
    environment = os.environ.copy()
    if routing_stub is not None:
        environment["FULFILLMENT_ROUTING_BASE_URL"] = routing_stub.base_url
    process = subprocess.Popen(
        [
            "dotnet",
            "run",
            "--no-launch-profile",
            "--project",
            project,
            "--urls",
            f"http://127.0.0.1:{port}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
        env=environment,
    )
    try:
        deadline = time.monotonic() + 30
        while True:
            if process.poll() is not None:
                raise RuntimeError(
                    "API exited before becoming ready:\n"
                    + (process.stdout.read() if process.stdout else "")
                )
            try:
                if request("GET", "/health")[0] == 200:
                    break
            except (OSError, urllib.error.URLError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("API readiness timeout")
            time.sleep(0.1)

        if mode == "vsa-allocation-feature":
            evaluate_vsa_allocation(routing_stub)
        else:
            created_status, reservation = request(
                "POST", "/reservations", {"sku": "widget", "quantity": 4}
            )
            assert created_status == 201, f"creation returned {created_status}"
            reservation_id = reservation["id"]
            assert inventory_quantity("/inventory/widget") == 6
            assert request("POST", f"/reservations/{reservation_id}/cancel")[0] == 204
            second_status = request("POST", f"/reservations/{reservation_id}/cancel")[0]
            available = inventory_quantity("/inventory/widget")
            assert_rejected(second_status, "repeated cancellation")
            assert available == 10, f"repeated cancellation left available={available}"
            if mode == "feature":
                assert_rejected(
                    request("POST", "/reservations", {"sku": "widget", "quantity": 11})[0],
                    "over-reservation",
                )
                assert_rejected(
                    request("POST", "/reservations", {"sku": "widget", "quantity": 0})[0],
                    "non-positive reservation",
                )
                status, confirmed = request(
                    "POST", "/reservations", {"sku": "widget", "quantity": 3}
                )
                assert status == 201
                assert request("POST", f"/reservations/{confirmed['id']}/confirm")[0] == 204
                assert request("POST", f"/reservations/{confirmed['id']}/cancel")[0] == 409
            elif mode == "vsa-feature":
                evaluate_vsa_feature()
        print(f"PASS: {mode} independent HTTP acceptance")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
