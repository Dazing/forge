# Implementation Plan: Phase 0 execution-boundary bootstrap

## Outcome
Go skeletons establish a signed canonical run-spec boundary, a forced-command launcher lifecycle contract, and a separate-user Unix-socket publisher contract without granting agents GitLab or Docker authority.

## Acceptance criteria
- `launcher/` accepts only a canonical, signed, non-expired run specification with a unique run ID and exposes no shell, PTY, or arbitrary command protocol.
- `publisher/` listens only on a Unix socket, rejects a patch whose expected base SHA differs from its clean re-clone, and permits only deterministic `factory/p-{project_id}-i-{issue_iid}` branches.
- The launcher/publisher packages build and their contract tests cover invalid signatures, replay/expiry, base mismatch, escaping symlink/submodule rejection, and non-`factory/*` branch rejection.

## Required skills
- `tdd` — use for signature/canonicalization, replay, patch-base, and branch-policy boundary tests before implementation.
- `vertical-slice-architecture` — governs launcher/publisher component boundaries: signed run-spec acceptance and patch publication are independently testable capability contracts; runspec/replay/transport are component-owned infrastructure; orchestrator composes these through explicit protocol contracts, never by importing internals.

## Repository findings
- `docs/roadmap.md: Phase 0` — requires a forced-command launcher accepting only signed canonical run specifications and a separate-OS-user Unix-socket publisher validating expected base SHA and pushing only `factory/*`.
- `docs/technical-design.md: §8.1` — fixes run-spec contents, signature/replay behavior, resource labeling, patch validation, no-fuzz application, and idempotent cleanup.
- `docs/technical-design.md: §8.3` — fixes the process-adapter input/output contract.

## Assumptions
- Use Go for both trusted binaries, selected by the user; use independent modules `factory.local/platform/launcher` and `factory.local/platform/publisher` until Phase 1 supplies GitLab paths.
- Phase 0 proves request validation and local lifecycle/publish contracts only; Docker execution and GitLab push use test fakes, not live credentials.


## Vertical-slice architecture
- `launcher` and `publisher` are separate trusted platform components, not slices of the orchestrator and not a shared business layer.
- Within each component, keep capability contracts cohesive: signed run-spec acceptance/lifecycle and patch publication/base validation are independently testable boundaries with their protocol, handler, state mapping, and behavioral tests.
- `runspec`, replay storage, Git transport, and socket framing are component-owned infrastructure; they must not become a generic plugin framework or leak authority into agent workspaces.
- The orchestrator later composes these boundaries through its `dispatch-planning-run` and `publish-validated-patch` slices. It must consume explicit protocol contracts rather than import launcher/publisher internals.

## Boundaries
### In scope
- Canonical run-spec and publisher request types, Ed25519 verification, persistent replay ledger, forced-command protocol, publisher Unix socket, local Git patch validation, resource-label/cleanup interfaces, and operator runbooks.

### Out of scope
- Starting real containers, model sidecars, egress firewalling, registry pulls, SSH account provisioning, live GitLab pushes/MRs, harness execution, and garbage collection of real Docker resources.

### Must preserve
- The launcher alone may later access Docker and registry credentials; the publisher alone may later hold Git write authority; neither authority enters an agent workspace.

## Contracts and behavior
- `runspec.RunSpec` contains run ID, issued/expiry UTC timestamps, immutable base SHA, role, image/assets digest references, selected command/skills, limits, services, network policy, and workspace archive reference; JSON is canonicalized before Ed25519 verification.
- `launcher.Server.Handle(ctx, envelope)` verifies signature, requires `expires_at > now`, rejects an already accepted `run_id`, records the accepted ID durably, and permits only `create`, `status`, `cancel`, and `destroy` operations bound to that run spec.
- `publisher.PublishRequest` contains project ID, issue IID, expected base SHA, patch archive path, and deterministic branch. `publisher.Server` re-clones the requested base, applies with no fuzz, rejects submodules/tree-escaping symlinks/credential markers, and rejects branches outside `factory/p-{project_id}-i-{issue_iid}`.
- `adapter.Contract` fixes `Run(role, workspace, taskJSON, policyJSON) -> events.jsonl + result.json + exit.json + workspace.diff`; it does not select a harness.

## Implementation steps
1. **Define and test the signed run-spec protocol**
   - Files: `launcher/go.mod`, `launcher/internal/runspec/runspec.go`, `launcher/internal/runspec/canonical.go`, `launcher/internal/runspec/runspec_test.go`
   - Symbols: `runspec.RunSpec`, `runspec.Envelope`, `runspec.CanonicalBytes(spec RunSpec) ([]byte, error)`, `runspec.Verify(envelope Envelope, publicKey ed25519.PublicKey, now time.Time) (RunSpec, error)`.
   - Change: Define the complete Phase 0 data shape, deterministic JSON encoding, Ed25519 verification, digest-only image/assets references, and strict expiry validation.
   - Preserve: No mutable image tag, arbitrary command, unbounded payload, or unsigned fallback is accepted.
   - Depends on: None.
2. **Create the forced-command launcher boundary and replay ledger**
   - Files: `launcher/cmd/factory-launcher/main.go`, `launcher/internal/server/server.go`, `launcher/internal/replay/store.go`, `launcher/internal/adapter/contract.go`, `launcher/internal/server/server_test.go`, `launcher/runbooks/forced-command.md`
   - Symbols: `server.Handle(ctx context.Context, envelope runspec.Envelope) (Result, error)`, `replay.Store.Claim(ctx context.Context, runID string, expiry time.Time) error`, `adapter.Contract`.
   - Change: Accept one framed request protocol on standard input/output suitable for an OpenSSH forced command; claim run IDs before lifecycle dispatch; define labeled resource and idempotent cleanup interfaces without calling Docker.
   - Preserve: Reject shell/PTY/forwarding semantics and never log signing material or workspace credential content.
   - Depends on: 1.
3. **Create the Unix-socket publisher validation boundary**
   - Files: `publisher/go.mod`, `publisher/cmd/factory-publisher/main.go`, `publisher/internal/protocol/protocol.go`, `publisher/internal/publish/service.go`, `publisher/internal/publish/validate.go`, `publisher/internal/publish/service_test.go`, `publisher/runbooks/socket-publisher.md`
   - Symbols: `protocol.PublishRequest`, `publish.Service.Publish(ctx context.Context, request protocol.PublishRequest) (protocol.PublishResult, error)`, `publish.ValidateBranch(projectID, issueIID int64, branch string) error`.
   - Change: Bind only a configured Unix socket with restrictive permissions; implement clean-base inspection and patch-tree validation behind a Git client interface; add deterministic branch validation and idempotency-key fields.
   - Preserve: No TCP listener, arbitrary ref, push outside `factory/*`, fuzz patch application, credential scanning bypass, or source-branch write path.
   - Depends on: None.

## Caller and dependency updates
- `orchestrator/internal/launcher` — later control-plane workflow code sends signed envelopes to the launcher forced command.
- `orchestrator/internal/publisher` — later control-plane workflow code sends `protocol.PublishRequest` to the publisher socket.
- `agent-assets/schemas/implementation.schema.json` — later assets plan defines the structured result validated by the adapter contract.

## Verification
- Command: `go test ./launcher/... ./publisher/...`
- Proves: invalid/expired/replayed run specs and invalid/base-mismatched/unsafe publication requests are rejected by the trusted boundaries.
- Success evidence: exit status 0 with all launcher and publisher contract tests passing.
- Not covered: real Docker lifecycle, OpenSSH daemon configuration, Unix account separation, and live GitLab push.

## Executor constraints
- Treat this file as the complete implementation specification; do not reopen the original request.
- Read the named target files before editing, but do not repeat the planner's discovery searches.
- Follow the named files, symbols, contracts, steps, boundaries, and verification command exactly.
- Do not add work not listed under **In scope**.
- If the repository no longer matches a stated finding, stop expanding the search, report the exact discrepancy, and make only the smallest inspection needed to resolve it.
- Load every skill under **Required skills** before editing. Load an additional skill only when new repository evidence makes it applicable; do not use skill loading to restart research.
- After the focused verification passes, stop. Do not run broader checks or continue polishing.
