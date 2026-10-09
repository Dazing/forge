#!/usr/bin/env sh
set -eu
exec python3 "$(dirname "$0")/api_evaluator.py" vsa-feature "$1"
