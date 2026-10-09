# Factory suite runbook

Complete [factory setup](runbook-setup.md) first.

## Run

From the repository root:

```bash
npm run check
npm test -- --run tests/integration/preflight.test.ts

PROOF_ID="$(date +%s)"
for scenario in feature bug refactor recovery-success recovery-exhaustion vsa-feature vsa-allocation-feature; do
  RUN_ID="$PROOF_ID-$scenario"
  npx tsx proof/harness/run-proof.ts config/factory.local.json \
    "proof/scenarios/$scenario.json" \
    "factory/proof-$scenario-$PROOF_ID" \
    "$RUN_ID"
done
```

Do not rerun failed proofs under the same `PROOF_ID`. Retain the evidence and diagnose the failure.

## Inspect

For each scenario:

```bash
SCENARIO=feature
RUN_ID="$PROOF_ID-$SCENARIO"
cat ".runs/evidence/$RUN_ID/report.json"
cat ".runs/evidence/$RUN_ID/artifacts/PR.md"
git -C ".runs/proof-inputs/$SCENARIO-$RUN_ID/source" \
  show --stat "factory/proof-$SCENARIO-$PROOF_ID"
```

## Diagnose stalled progress

Start with the read-only status command:

```bash
npm run factory -- status --config config/factory.local.json --run-id "$RUN_ID"
```

It reports the active operation, elapsed and remaining time, last durable transition, last observation, transcript path, and supervisor state. Then inspect `.runs/evidence/<run-id>/supervisor.json`, the final lines of `events.jsonl`, the named transcript, the preserved workspace, and trusted gate output—in that order.

Every `FACTORY_PROGRESS` record is appended to `events.jsonl` before it is printed. `attempt-transcript-ready` means the host transcript exists; `attempt-runner-entered` means control entered Sandcastle; `attempt-agent-activity-started` means the agent emitted its first stream event; `attempt-shutdown-stalled` means cancellation was not confirmed within `attemptShutdownGraceSeconds` and no retry or later stage is allowed.

Transitions carry absolute deadlines. `attempt-status` observations expose elapsed/remaining time, transcript size/mtime, and last agent activity but cannot extend a deadline. Both the normal CLI and proof launcher run a supervised worker. The supervisor records the last transition and observation, sends `SIGINT` at the active deadline, escalates to `SIGKILL` after its grace period, and atomically writes `supervisor.json`.

Missing transcript after `attempt-preparing` means preparation has not reached transcript creation. In proof runs this includes the fault-injection wrapper before backend setup. A transcript that ends before `Agent started` is a Sandcastle/sandbox startup failure. `attempt-runner-entered` without `attempt-agent-activity-started` is an agent/provider startup failure. Preserve the run ID, workspace, events, transcript, trusted evidence, and supervisor diagnostic; automatic resume remains unsupported because verifier state and authoritative-suite binding are in-memory.

The proof wrapper forwards backend lifecycle events for both stage and pull-request attempts. Workspace digests run only for the configured fault's stage and attempt, exclude `.git`, `.sandcastle`, `.factory/verification-runtime`, and `bin`/`obj` directories, and hash regular files and symlink targets without reading special files. This prevents leftover .NET `clr-debug-pipe-*` FIFOs from blocking the implementation-to-refactor handoff or generated outputs from satisfying a source-change fault. Digest traversal checks cancellation and the absolute attempt deadline; regular-file reads are abortable. A stopped digest returns `cancelled` or `timeout` without realizing the fault and retains any evidence already returned by the agent.

Expected results:

- `feature`, `bug`, `refactor`, `recovery-success`, `vsa-feature`, and `vsa-allocation-feature`: `succeeded` with a new output branch and host-owned `artifacts/PR.md`.
- `recovery-exhaustion`: bounded failure accepted by its independent evaluator; no success branch or `PR.md`.
- The base branch remains unchanged in every source repository, and `PR.md` is not committed into an output branch.

## Diagnose acceptance correction failures

Test design and the single acceptance-correction operation may edit only the configured candidate-suite directory in the repository. Each backend invocation receives a fresh writable scratch mount at `/home/agent/factory-scratch`, outside the candidate workspace and protected inputs. Put temporary probe scripts, logs, and exploratory output there—not under `.factory/probe`. Scratch is not publication input. Record durable observations in the completion report; scratch paths are temporary and are not trusted gate artifacts.

The backend removes scratch after the runner stops and the real Docker adapter confirms no running container still mounts it. A stalled runner or uncertain Docker inspection retains scratch; the transcript records the retained path when release cannot be confirmed. Do not manually delete retained scratch while an owned worker may still use it. Do not broaden repository exclusions to hide an unauthorized write.

For a failed correction, inspect the `acceptance-correction` gate event:

- `reasonCode: correction-boundary-violation` means protected workspace content changed. `diagnostics` records added, modified, and deleted relative paths; before/after identities; effective exclusions; and run/ticket/base/suite binding. Protected content includes helper scripts outside permitted paths, not just production source.
- `correction-rejected` means the submitted report or corrected suite was not acceptable.
- `correction-execution-failed` means correction execution failed or timed out; inspect its attempt status and transcript.
- `correction-budget-unavailable` means the single correction route is no longer available under the existing stage limits.

`report.json` carries `outcome.terminalReasonCode`; the terminal events, Markdown report, and CLI preserve the actual correction cause. A correction rejected after normal attempt 1 terminates without publication; it is not reported as two exhausted normal attempts. Historical reports are not rewritten or automatically resumed.

Local probe success is an agent claim. A corrected suite must still pass host validation against the original baseline, receive a new frozen identity, and pass renewed implementation checks. Baseline RED does not prove an expectation is correct: derive setup state and the predicate explicitly (`10 - 4 = 6` available; quantity 9 needs delta 5 and succeeds; quantity 11 needs delta 7 and conflicts).


## Diagnose evidence, review, and repair

Host evidence bundles use schema version 1. Each check records command identity, exit status, discovered/skipped counts when available, verifier tree identity, acceptance digest when applicable, and a sanitized output artifact. Failed checks also carry a bounded decisive excerpt. Agents see copied artifacts only under `/home/agent/factory-inputs/evidence/`; host verifier paths are not exposed. Boundary failures may have no checks and still retain typed diagnostics.

Full stage reports are stored under `.runs/evidence/<run-id>/artifacts/reports/`. Prompts receive compact summaries, unresolved issues, and mounted report pointers rather than accumulated report JSON. Evidence from an older tree or suite remains historical and cannot approve a changed candidate.

Review and re-review run against host-created read-only analysis copies, including repository metadata, with writable `/home/agent/factory-scratch`. A write denial is expected. If the host detects any analysis-input identity change, the operation fails. Generated probe outputs belong in scratch; source edited in a disposable scratch copy cannot become publication input.

Interpret terminal behavior by operation:

- Backend `execution-failure`, `timeout`, `cancelled`, and `shutdown-stalled` describe operation execution. Cancellation or stalled shutdown prevents later operations.
- A completed review with `changes-required` is a valid judgment. Its blocking findings route to repair rather than consuming a review execution retry.
- At most two repair rounds are shared across refactor and review findings. Each round reserves one repair operation (up to two execution attempts), trusted implementation checks, and one scoped re-review operation (up to two execution attempts).
- Repair claims are `addressed` or `disputed`; neither closes a finding. Re-review alone records `verified-resolved` or evidence-backed `dismissed`.
- Budget exhaustion preserves every unresolved finding and prevents publication. Advisory findings do not consume rounds.

`report.json` records `repairRoundsUsed`, stable findings and lifecycle, and `approvedReviewTreeId`. `report.md` renders the same operator-level state. The status command exposes the active operation, repair round, reviewed tree, and open-blocker count when present in the current lifecycle event.

## Acceptance expectation provenance

Candidate manifests use `schemaVersion: 2` and include `expectations`. Every consequential assertion group names covered criteria, target case/step, provenance, distinguishing input/result, rejected incorrect behavior, material-alternative state, ambiguity state, and whether the value is derived. Derived expectations also record setup state, transition/calculation, and predicate.

The host validates structure, criterion coverage, ticket/suite binding, and unresolved material ambiguity before freeze. It does not certify arithmetic or semantic truth. A material unresolved alternative or material unsupported assumption blocks freeze. Any corrected suite receives a new digest; host evidence and review against the old suite remain historical.

Failure evidence is under `.runs/evidence/<run-id>/`; preserved workspaces are under `.runs/workspaces/`.
