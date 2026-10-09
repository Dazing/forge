#!/usr/bin/env python3
"""Host-owned deterministic fulfillment-routing service for proof execution."""

from __future__ import annotations

import json
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterator


@dataclass(frozen=True)
class RoutingRequest:
    sku: object
    destination_postal_code: object


class RunningFulfillmentRoutingStub:
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._requests: list[RoutingRequest] = []
        self._gates: dict[str, threading.Event] = {}
        owner = self

        class RoutingHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
                if self.path != "/routes":
                    self._send(404, None)
                    return

                try:
                    payload = json.loads(self._read_body())
                except (ValueError, json.JSONDecodeError):
                    self._send(400, None)
                    return

                if not isinstance(payload, dict):
                    self._send(400, None)
                    return
                sku = payload.get("sku")
                postal_code = payload.get("destinationPostalCode")
                owner._record(RoutingRequest(sku, postal_code))
                owner._wait_if_blocked(postal_code)

                if postal_code == "94105":
                    self._send(
                        200,
                        {
                            "routes": [
                                {"location": "south", "priority": 1},
                                {"location": "north", "priority": 2},
                            ]
                        },
                    )
                elif postal_code == "10001":
                    self._send(
                        200,
                        {
                            "routes": [
                                {"location": "north", "priority": 1},
                                {"location": "south", "priority": 2},
                            ]
                        },
                    )
                elif postal_code == "60601":
                    self._send(
                        200,
                        {
                            "routes": [
                                {"location": "central", "priority": 1},
                                {"location": "north", "priority": 2},
                                {"location": "south", "priority": 3},
                            ]
                        },
                    )
                elif postal_code == "50300":
                    self._send(503, {"error": "routing unavailable"})
                elif postal_code == "00000":
                    self._send(
                        200,
                        {
                            "routes": [
                                {"location": " ", "priority": 0},
                                {"location": "north", "priority": 1},
                                {"location": "NORTH", "priority": 1},
                            ]
                        },
                    )
                elif postal_code == "99999":
                    time.sleep(0.8)
                    self._send(200, {"routes": [{"location": "north", "priority": 1}]})
                else:
                    self._send(404, {"error": "unknown destination"})

            def _read_body(self) -> bytes:
                if self.headers.get("Transfer-Encoding", "").lower() != "chunked":
                    length = int(self.headers.get("Content-Length", "0"))
                    return self.rfile.read(length)

                chunks: list[bytes] = []
                while True:
                    size_line = self.rfile.readline().strip()
                    if not size_line:
                        raise ValueError("missing chunk size")
                    size = int(size_line.split(b";", 1)[0], 16)
                    if size == 0:
                        self.rfile.readline()
                        return b"".join(chunks)
                    chunks.append(self.rfile.read(size))
                    if self.rfile.read(2) != b"\r\n":
                        raise ValueError("malformed chunk terminator")

            def _send(self, status: int, payload: object | None) -> None:
                encoded = b"" if payload is None else json.dumps(payload).encode("utf-8")
                try:
                    self.send_response(status)
                    if payload is not None:
                        self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    if encoded:
                        self.wfile.write(encoded)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, format: str, *args: object) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), RoutingHandler)
        self._server.daemon_threads = False
        host, port = self._server.server_address
        self.base_url = f"http://{host}:{port}"
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="fulfillment-routing-stub",
            daemon=True,
        )

    @property
    def requests(self) -> tuple[RoutingRequest, ...]:
        with self._condition:
            return tuple(self._requests)

    @property
    def request_count(self) -> int:
        with self._condition:
            return len(self._requests)

    def request_count_for(self, postal_code: str) -> int:
        with self._condition:
            return sum(
                request.destination_postal_code == postal_code for request in self._requests
            )

    def block(self, postal_code: str) -> None:
        with self._condition:
            gate = self._gates.setdefault(postal_code, threading.Event())
            gate.clear()

    def release(self, postal_code: str) -> None:
        with self._condition:
            gate = self._gates.get(postal_code)
            if gate is not None:
                gate.set()

    def wait_for_requests(self, postal_code: str, count: int, timeout: float = 2.0) -> bool:
        deadline = time.monotonic() + timeout
        with self._condition:
            while self.request_count_for(postal_code) < count:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
            return True

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        with self._condition:
            for gate in self._gates.values():
                gate.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
        if self._thread.is_alive():
            raise RuntimeError("fulfillment-routing stub did not stop")

    def _record(self, request: RoutingRequest) -> None:
        with self._condition:
            self._requests.append(request)
            self._condition.notify_all()

    def _wait_if_blocked(self, postal_code: object) -> None:
        if not isinstance(postal_code, str):
            return
        with self._condition:
            gate = self._gates.get(postal_code)
        if gate is not None:
            gate.wait(timeout=5)


@contextmanager
def fulfillment_routing_stub() -> Iterator[RunningFulfillmentRoutingStub]:
    stub = RunningFulfillmentRoutingStub()
    stub.start()
    try:
        yield stub
    finally:
        stub.stop()
