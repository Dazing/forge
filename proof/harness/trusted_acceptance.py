#!/usr/bin/env python3
"""Host-owned interpreter for declarative black-box acceptance cases."""

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from fulfillment_routing_stub import fulfillment_routing_stub


def fail_result(test_id: str, criteria: list[str], kind: str) -> dict:
    return {"id": test_id, "status": "failed", "failureKind": kind, "criteria": criteria}


def request_json(base_url: str, step: dict) -> tuple[int, object | None]:
    body = json.dumps(step["json"]).encode() if "json" in step else None
    request = urllib.request.Request(
        base_url + step["path"],
        data=body,
        method=step.get("method", "GET"),
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else None
    except urllib.error.HTTPError as error:
        payload = error.read()
        try:
            parsed = json.loads(payload) if payload else None
        except json.JSONDecodeError:
            parsed = None
        return error.code, parsed


def value_at(payload: object, path: str) -> object:
    current = payload
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdecimal():
            index = int(part)
            if index >= len(current):
                raise AssertionError(f"JSON path {path} was not present")
            current = current[index]
        else:
            raise AssertionError(f"JSON path {path} was not present")
    return current


def run_case(workspace: Path, case: dict) -> dict:
    test_id = case["id"]
    criteria = case["criteria"]
    process: subprocess.Popen | None = None
    try:
        with fulfillment_routing_stub() as routing_stub:
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            base_url = f"http://127.0.0.1:{port}"
            environment = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": os.environ.get("HOME", str(workspace)),
                "DOTNET_CLI_HOME": os.environ.get(
                    "DOTNET_CLI_HOME", str(workspace / ".dotnet")
                ),
                "ASPNETCORE_ENVIRONMENT": "Testing",
                "FULFILLMENT_ROUTING_BASE_URL": routing_stub.base_url,
            }
            process = subprocess.Popen(
                [
                    "dotnet",
                    "run",
                    "--no-build",
                    "--project",
                    "src/Inventory.Api/Inventory.Api.csproj",
                    "--urls",
                    base_url,
                ],
                cwd=workspace,
                env=environment,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        return fail_result(test_id, criteria, "infrastructure")
                    try:
                        status, _ = request_json(base_url, {"path": "/health"})
                        if status == 200:
                            break
                    except (OSError, urllib.error.URLError):
                        time.sleep(0.1)
                else:
                    return fail_result(test_id, criteria, "infrastructure")

                captures: dict[str, object] = {}
                for step in case["steps"]:
                    rendered = json.loads(
                        json.dumps(step).replace(
                            "${reservationId}",
                            str(captures.get("reservationId", "")),
                        )
                    )
                    status, payload = request_json(base_url, rendered)
                    expected = rendered["expect"]
                    if status != expected["status"]:
                        raise AssertionError(
                            f"expected HTTP {expected['status']}, received {status}"
                        )
                    for path, expected_value in expected.get("json", {}).items():
                        if value_at(payload, path) != expected_value:
                            raise AssertionError(f"expected {path}={expected_value!r}")
                    capture_path = rendered.get("captureReservationId")
                    if capture_path:
                        captures["reservationId"] = value_at(payload, capture_path)
                return {"id": test_id, "status": "passed", "criteria": criteria}
            except (
                AssertionError,
                KeyError,
                TypeError,
                urllib.error.URLError,
                OSError,
            ):
                return fail_result(test_id, criteria, "assertion")
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
    except (OSError, RuntimeError):
        return fail_result(test_id, criteria, "infrastructure")


def load_cases(suite: Path) -> list[dict]:
    manifest = json.loads((suite / "manifest.json").read_text())
    cases = []
    for item in manifest["tests"]:
        case_path = (suite / item["file"]).resolve()
        if suite.resolve() not in case_path.parents or case_path.suffix != ".json":
            raise ValueError("case file must be contained JSON")
        case = json.loads(case_path.read_text())
        if case.get("id") != item["id"] or case.get("criteria") != item["criteria"]:
            raise ValueError("case identity does not match manifest")
        if not isinstance(case.get("steps"), list) or not case["steps"]:
            raise ValueError("case requires steps")
        cases.append(case)
    return cases


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--suite", required=True)
    args = parser.parse_args()
    try:
        cases = load_cases(Path(args.suite))
        results = [run_case(Path(args.workspace), case) for case in cases]
    except Exception:
        results = [{"id": "suite-setup", "status": "failed", "failureKind": "infrastructure", "criteria": ["suite"]}]
    summary = {"discovered": len(results), "skipped": 0, "tests": results}
    print("FACTORY_TEST_RESULT=" + json.dumps(summary, separators=(",", ":")))
    return 0 if all(result["status"] == "passed" for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
