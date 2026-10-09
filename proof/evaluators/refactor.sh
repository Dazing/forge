#!/usr/bin/env sh
set -eu
repo=$1
python3 "$(dirname "$0")/api_evaluator.py" bug "$repo"
dotnet build "$repo/src/Inventory.Api/Inventory.Api.csproj" --nologo >/dev/null
dotnet run --project "$(dirname "$0")/StructureEvaluator/StructureEvaluator.csproj" -- \
  "$repo/src/Inventory.Api/bin/Debug/net10.0/Inventory.Api.dll"
