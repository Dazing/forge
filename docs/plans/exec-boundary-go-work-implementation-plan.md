# Implementation Plan: execution-boundary go.work publisher fix

## Outcome
The repo-root `go.work` workspace includes the `publisher` module, so the `go test ./publisher/...` command (and any workspace-rooted `go build`/`go test`) works from the repo root instead of failing with "directory prefix publisher does not contain modules listed in go.work". The publisher is added to the execution boundary without altering any publisher source.

## Acceptance criteria
- `go test ./publisher/...` run from the repo root succeeds (exit 0).
- `go build ./...` from the repo root succeeds.
- The other workspace modules (`ci-templates`, `orchestrator`, `launcher`, `agent-assets`) remain in the workspace and their tests still pass.
- No file under `publisher/` is modified.

## Required skills
- `coding-best-practices` — keep the change to the single-line `go.work` addition; no reformatting or reordering of existing `use` directives.

## Repository findings
- `go.work:3-6` — the workspace lists `use ./ci-templates`, `use ./orchestrator`, `use ./launcher`, `use ./agent-assets`. `./publisher` is absent.
- `publisher/go.mod:1` — the module path is `factory.local/platform/publisher` (Go 1.22, matching the workspace `go 1.22` at `go.work:1`).
- `publisher/internal/publish/service_test.go`, `publisher/internal/publish/validate.go`, `publisher/cmd/factory-publisher/main.go` — the publisher packages and their tests already exist; only the workspace membership is missing.
- Measured behavior: `go test ./publisher/...` from the repo root fails under the current `go.work` ("directory prefix publisher does not contain modules listed in go.work"); it passes in isolation via `GOWORK=off go test ./...` run from `publisher/`.

## Assumptions
- `publisher` is a first-class execution-boundary module of the same Go version as the workspace (it is: both `go 1.22`), so no workspace `go`-version bump is required.
- No module `replace` directives are needed; the publisher is resolved as a normal workspace member.

## Boundaries
### In scope
- `go.work`: add the single line `use ./publisher`.

### Out of scope
- Any change to `publisher/` source, tests, or `go.mod`.
- Adding, removing, or reordering any other `use` directive.
- The two deferred minor items (orchestrator `webhook_delivery.project_id` FK; reference-app concurrency test).

### Must preserve
- The four existing `use` directives and the `go 1.22` line.

## Contracts and behavior
- The workspace is the set of `use` directives in `go.work`; adding `use ./publisher` registers the `factory.local/platform/publisher` module so workspace-rooted commands resolve it.

## Implementation steps
1. **Add the publisher to the workspace**
   - File: `go.work`.
   - After the `use ./agent-assets` line (line 6), add one line:
     ```
     use ./publisher
     ```
   - Preserve: the `go 1.22` line (line 1) and all four existing `use` directives; do not reorder or reformat them.

## Caller and dependency updates
- None. The change is workspace membership only; no source, test, or `go.mod` is touched.

## Verification
- Command: `go test ./publisher/...`
- Proves: the publisher module is now part of the root workspace and its tests compile and pass under `go test` invoked from the repo root (the exact command that currently fails).
- Success evidence: exit status 0 with the publisher `publish` package tests passing under the workspace.
- Not covered: cross-module integration between `publisher` and the orchestrator (the orchestrator's caller wiring is a later control-plane plan, not this membership fix).

## Executor constraints
- Treat this file as the complete implementation specification; do not reopen the original request.
- Read `go.work` before editing, but do not repeat the planner's discovery searches.
- Follow the named file, the single-line change, and the verification command exactly.
- Do not add work not listed under **In scope**.
- After the focused verification passes, stop. Do not run broader checks or continue polishing.
