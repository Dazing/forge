#!/usr/bin/env sh
set -eu
report=$1
python3 - "$report" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
attempts = [a for a in value["attempts"] if a["stage"] == "implementation"]
assert value["status"] == "failed", value["status"]
assert len(attempts) == 2, len(attempts)
assert [a["attempt"] for a in attempts] == [1, 2]
assert all(a["status"] == "execution-failure" for a in attempts)
assert not any(a["stage"] in ("refactor", "review") for a in value["attempts"])
print("PASS: recovery exhausted after exactly two implementation attempts")
PY
