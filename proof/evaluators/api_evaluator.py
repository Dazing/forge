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
    assert request("GET", "/inventory/widget")[1]["available"] == 6
    assert request("POST", f"/reservations/{reservation_id}/cancel")[0] == 204
    second_status = request("POST", f"/reservations/{reservation_id}/cancel")[0]
    available = request("GET", "/inventory/widget")[1]["available"]
    assert second_status == 409, f"repeated cancellation returned {second_status}"
    assert available == 10, f"repeated cancellation left available={available}"
    if mode == "feature":
        assert request("POST", "/reservations", {"sku": "widget", "quantity": 11})[0] == 409
        assert request("POST", "/reservations", {"sku": "widget", "quantity": 0})[0] == 409
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
