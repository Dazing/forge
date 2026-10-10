# Inventory API agent instructions

- Target .NET 10 with nullable reference types enabled.
- Make the smallest test-first correction; do not redesign the HTTP API.
- Stock and reservation mutations must be atomic.
- A terminal reservation transition must never mutate stock a second time.
- Run the repository-local test executable and API build.
- Read relevant supplied skills from Pi's read-only global skills directory at `~/.pi/agent/skills/`, including companion files referenced by each skill. Do not modify those skills or access files outside this checkout except that directory.
