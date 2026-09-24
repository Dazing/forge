# Implementation Plan: launcher lifecycle claim and expiry fixes

## Outcome
The launcher forced-command boundary claims a run ID only on `create` and treats `status`/`cancel`/`destroy` as idempotent follow-up operations on an already-created run, so an operator follow-up no longer dead-ends on a replay error. Run-spec expiry enforces the strict `expires_at > now` contract instead of accepting `expires_at == now`.

## Acceptance criteria
- A duplicate `create` for the same `run_id` is rejected as a replay; the first `create` succeeds.
- `status`, `cancel`, and `destroy` on a `run_id` that was previously `create`d succeed without re-claiming; each on a `run_id` that was never `create`d is rejected.
- `runspec.Verify` rejects a spec whose `expires_at` equals `now`, not only specs whose `expires_at` is strictly in the past.
- `go test ./launcher/...` passes.

## Required skills
- `tdd` — write the follow-up-op and expiry-at-now tests first, then implement the `Handle` claim split and the `Verify` boundary so each new behavior is covered before the change lands.
- `vertical-slice-architecture` — keep the claim boundary in `launcher/internal/server` and the expiry contract in `launcher/internal/runspec`; the replay ledger stays `replay.Store`, no new shared surface.

## Repository findings
- `launcher/internal/server/server.go:63-94` — `Handle` runs `runspec.Verify` (line 65), then unconditionally `s.Ledger.Claim(ctx, spec.RunID, spec.ExpiresAt)` at line 71 before the op switch at line 75. Every op (including follow-ups) therefore re-claims; a follow-up on a claimed `run_id` returns `replay: run_id ... already accepted`.
- `launcher/internal/replay/store.go:70-94` — `Claim(ctx, runID, expiry)` errors on an already-claimed `run_id` with `replay: run_id %q already accepted` (line 77). `launcher/internal/replay/store.go:97-102` — `Has(ctx, runID) bool` reports whether a `run_id` was claimed, without claiming.
- `launcher/internal/server/server.go:23-26` — ops are `OpCreate="create"`, `OpStatus="status"`, `OpCancel="cancel"`, `OpDestroy="destroy"`. The current switch (lines 75-90) maps states: `create`→`running`, `status`→`unknown`, `cancel`→`cancelling`, `destroy`→`destroying`.
- `launcher/internal/runspec/runspec.go:159` — `if spec.ExpiresAt.Before(now)` accepts `ExpiresAt == now`; the contract is `expires_at > now` (see the field doc at `runspec.go:27` and the design in `docs/technical-design.md: §8.1`).
- `launcher/internal/server/server_test.go:80-97` — `TestHandle_RejectsReplayedRunID` currently makes `OpStatus` the second op and asserts it MUST fail with "already accepted". After the fix `OpStatus` on a claimed `run_id` succeeds, so this test must be re-grounded to a second `OpCreate`.
- `launcher/internal/runspec/runspec_test.go:65-83` — `TestVerify_RejectsExpiredSpec` uses `now.Add(-1h)` (strictly past) and is the only expiry test; the `ExpiresAt == now` boundary is untested.

## Assumptions
- Follow-up ops (`status`/`cancel`/`destroy`) are valid only on a `run_id` that was previously `create`d in this ledger. A follow-up on an unknown `run_id` is rejected with a distinct "not created" error, distinct from the replay error. This matches the design's lifecycle ordering (a run is created, then queried/cancelled/destroyed).
- The op state strings (`running`, `unknown`, `cancelling`, `destroying`) are unchanged; Phase 3 replaces them with real Docker lifecycle states.

## Boundaries
### In scope
- `launcher/internal/server/server.go`: split the claim to `create` only and add the `Has` guard for follow-up ops inside `Handle`.
- `launcher/internal/runspec/runspec.go`: the strict expiry boundary in `Verify`.
- `launcher/internal/server/server_test.go`: re-ground `TestHandle_RejectsReplayedRunID` to `OpCreate` and add a follow-up-op test.
- `launcher/internal/runspec/runspec_test.go`: add an expiry-at-now test.

### Out of scope
- Wiring real Docker lifecycle into `Handle` (Phase 3).
- The two deferred minor items (orchestrator `webhook_delivery.project_id` FK; reference-app concurrency test).

### Must preserve
- Replay protection on `create` (a duplicate `create` is rejected).
- Signature and expiry verification in `runspec.Verify` (only the `== now` boundary changes).
- The `replay.Store` API (`Claim`, `Has`, `Close`) — no new methods.

## Contracts and behavior
- `Handle`: after `runspec.Verify`, route by op. `OpCreate` → `Claim` (re-claim rejected as replay), state `running`. `OpStatus`/`OpCancel`/`OpDestroy` → require `Has(run_id)` (reject if the run was never created), no claim, states `unknown`/`cancelling`/`destroying`. Unsupported op → error.
- `Verify`: reject when `now >= ExpiresAt` (equivalently `!ExpiresAt.After(now)`), accepting only `ExpiresAt > now`.

## Implementation steps
1. **Write the follow-up-op and replay re-grounding tests**
   - File: `launcher/internal/server/server_test.go`.
   - Rewrite `TestHandle_RejectsReplayedRunID` (lines 80-97): first `OpCreate` with `validSpec("run-replay", now.Add(10*time.Minute))` succeeds; a second `OpCreate` with the **same** `run_id` and same envelope must fail, and the error must contain `already accepted` (the `Claim` error, wrapped). Do not keep the `OpStatus` second op.
   - Add `TestHandle_AcceptsFollowUpOpsOnCreatedRun`: `srv, _, priv := newServer(t)`; `env, _ := runspec.NewEnvelope(validSpec("run-followup", now.Add(10*time.Minute)), priv)`; `OpCreate` succeeds; then `OpStatus`, `OpCancel`, `OpDestroy` on the same `run_id`/`env` all return no error and states `unknown`, `cancelling`, `destroying` respectively.
   - Add `TestHandle_RejectsFollowUpOnUnknownRun`: a fresh `newServer(t)`; `OpStatus` on a `run_id` that was never created returns an error (assert it is the "not created" error, not the replay error).
   - Preserve: `newServer` returns `(*server.Server, ed25519.PublicKey, ed25519.PrivateKey)`; `validSpec(runID, expiresAt)` builds the spec.

2. **Split the claim in `Handle`**
   - File: `launcher/internal/server/server.go`, `Handle` (lines 63-94).
   - Remove the unconditional `Claim` at line 71. Move the claim into the `OpCreate` case only:
     ```go
     case OpCreate:
         if err := s.Ledger.Claim(ctx, spec.RunID, spec.ExpiresAt); err != nil {
             return OpResult{}, fmt.Errorf("server: claim run %q: %w", spec.RunID, err)
         }
         return OpResult{Op: req.Op, RunID: spec.RunID, State: "running"}, nil
     ```
   - For `OpStatus, OpCancel, OpDestroy`, add the follow-up guard before the state switch:
     ```go
     case OpStatus, OpCancel, OpDestroy:
         if !s.Ledger.Has(ctx, spec.RunID) {
             return OpResult{}, fmt.Errorf("server: run %q has not been created", spec.RunID)
         }
         state := "unknown"
         if req.Op == OpCancel {
             state = "cancelling"
         } else if req.Op == OpDestroy {
             state = "destroying"
         }
         return OpResult{Op: req.Op, RunID: spec.RunID, State: state}, nil
     ```
   - Preserve: `default:` returns `server: unsupported op %q`; the `runspec.Verify` error wrap at lines 66-68.
   - Depends on: step 1 (tests define the expected behavior first).

3. **Add the expiry-at-now test**
   - File: `launcher/internal/runspec/runspec_test.go`.
   - Add `TestVerify_RejectsExpiryAtNow`: `pub, priv, _ := runspec.NewKeyPair()`; `now := time.Now().UTC()`; `spec := validSpec(now)` (so `ExpiresAt == now`); `env, _ := runspec.NewEnvelope(spec, priv)`; `runspec.Verify(env, pub, now)` must return a non-nil error. Keep the existing `TestVerify_RejectsExpiredSpec` (strictly-past case) unchanged.

4. **Fix the expiry boundary**
   - File: `launcher/internal/runspec/runspec.go`, `Verify` (line 159).
   - Change `if spec.ExpiresAt.Before(now) {` to `if !spec.ExpiresAt.After(now) {`. Leave the `fmt.Errorf("runspec: expired at %s", ...)` body (lines 160-161) unchanged.
   - Preserve: the `IssuedAt`/`ExpiresAt` UTC normalization above; all other `Verify` checks.

## Caller and dependency updates
- `orchestrator/internal/launcher` (later control-plane code) sends the signed follow-up ops to the launcher forced command; the `create`-only claim does not change the envelope or op encoding, only the replay semantics, so no orchestrator change is required in this phase.
- No caller change is needed for the `Verify` boundary change; it only tightens an existing contract.

## Verification
- Command: `go test ./launcher/...`
- Proves: a duplicate `create` is rejected as a replay, follow-up ops succeed on a created run and are rejected on an unknown run, and a spec with `expires_at == now` is rejected.
- Success evidence: exit status 0 with all `launcher` tests passing, including `TestHandle_AcceptsFollowUpOpsOnCreatedRun`, `TestHandle_RejectsFollowUpOnUnknownRun`, and `TestVerify_RejectsExpiryAtNow`.
- Not covered: real Docker lifecycle, OpenSSH forced-command wiring, and cross-process ledger durability beyond the single-process tests.

## Executor constraints
- Treat this file as the complete implementation specification; do not reopen the original request.
- Read the named target files before editing, but do not repeat the planner's discovery searches.
- Follow the named files, symbols, contracts, steps, and verification command exactly.
- Do not add work not listed under **In scope**.
- If `TestHandle_RejectsReplayedRunID` still references an `OpStatus` second op after the change, that is the re-grounding miss — the second op must be a duplicate `OpCreate`.
- After the focused verification passes, stop. Do not run broader checks or continue polishing.
