#!/usr/bin/env python3
import json, os, signal, socket, subprocess, sys, time, urllib.error, urllib.request

mode, repository = sys.argv[1], os.path.abspath(sys.argv[2])
project = os.path.join(repository, "src", "Inventory.Api", "Inventory.Api.csproj")
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
process = subprocess.Popen(["dotnet", "run", "--no-launch-profile", "--project", project, "--urls", f"http://127.0.0.1:{port}"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)

def request(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        return error.code, None

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
    assert 400 <= status < 500, f"{operation} returned {status}, expected an explicit 4xx rejection"

try:
    deadline = time.monotonic() + 30
    while True:
        if process.poll() is not None:
            raise RuntimeError("API exited before becoming ready:\n" + (process.stdout.read() if process.stdout else ""))
        try:
            if request("GET", "/health")[0] == 200: break
        except (OSError, urllib.error.URLError): pass
        if time.monotonic() >= deadline: raise RuntimeError("API readiness timeout")
        time.sleep(.1)

    created_status, reservation = request("POST", "/reservations", {"sku": "widget", "quantity": 4})
    assert created_status == 201, f"creation returned {created_status}"
    reservation_id = reservation["id"]
    assert inventory_quantity("/inventory/widget") == 6
    assert request("POST", f"/reservations/{reservation_id}/cancel")[0] == 204
    second_status = request("POST", f"/reservations/{reservation_id}/cancel")[0]
    assert_rejected(second_status, "repeated cancellation")
    available = inventory_quantity("/inventory/widget")
    assert available == 10, f"repeated cancellation left available={available}"
    if mode == "feature":
        assert_rejected(request("POST", "/reservations", {"sku": "widget", "quantity": 11})[0], "over-reservation")
        assert_rejected(request("POST", "/reservations", {"sku": "widget", "quantity": 0})[0], "non-positive reservation")
        status, confirmed = request("POST", "/reservations", {"sku": "widget", "quantity": 3})
        assert status == 201
        assert request("POST", f"/reservations/{confirmed['id']}/confirm")[0] == 204
        assert request("POST", f"/reservations/{confirmed['id']}/cancel")[0] == 409
    print(f"PASS: {mode} independent HTTP acceptance")
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
