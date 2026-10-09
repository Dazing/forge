import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runPython(source: string): void {
  const result = spawnSync("python3", ["-c", source], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

describe("protected acceptance runner", () => {
  it("traverses dictionary members and non-negative numeric list indices", () => {
    runPython(`
import sys
sys.path.insert(0, "proof/harness")
from trusted_acceptance import value_at

payload = {"allocations": [{"location": "SOUTH", "quantity": 7}, {"location": "NORTH", "quantity": 2}]}
assert value_at(payload, "allocations.0.location") == "SOUTH"
assert value_at(payload, "allocations.1.quantity") == 2
for path in ("allocations.-1.location", "allocations.first.location", "allocations.2.location"):
    try:
        value_at(payload, path)
    except AssertionError:
        pass
    else:
        raise AssertionError(f"invalid list path was accepted: {path}")
`);
  });

  it("owns a deterministic routing stub and closes it after the context exits", () => {
    runPython(`
import json
import socket
import sys
import urllib.parse
import urllib.request
sys.path.insert(0, "proof/harness")
from fulfillment_routing_stub import fulfillment_routing_stub

with fulfillment_routing_stub() as stub:
    base_url = stub.base_url
    request = urllib.request.Request(
        base_url + "/routes",
        data=json.dumps({"sku": "WIDGET", "destinationPostalCode": "94105"}).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=2) as response:
        assert response.status == 200
        assert json.loads(response.read()) == {
            "routes": [
                {"location": "south", "priority": 1},
                {"location": "north", "priority": 2},
            ]
        }
    assert stub.request_count == 1

parsed = urllib.parse.urlparse(base_url)
try:
    socket.create_connection((parsed.hostname, parsed.port), timeout=0.2)
except OSError:
    pass
else:
    raise AssertionError("routing stub still accepted connections after shutdown")
`);
  });

  it("accepts chunked JSON emitted by the .NET routing client", () => {
    runPython(`
import http.client
import json
import sys
import urllib.parse
sys.path.insert(0, "proof/harness")
from fulfillment_routing_stub import fulfillment_routing_stub

with fulfillment_routing_stub() as stub:
    parsed = urllib.parse.urlparse(stub.base_url)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=2)
    payload = json.dumps({"sku": "WIDGET", "destinationPostalCode": "10001"}).encode()
    connection.request(
        "POST",
        "/routes",
        body=iter((payload[:10], payload[10:])),
        headers={"Content-Type": "application/json"},
        encode_chunked=True,
    )
    response = connection.getresponse()
    assert response.status == 200
    response.read()
    connection.close()
    assert stub.request_count == 1
`);
  });
});
