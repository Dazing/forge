# Factory suite runbook

Complete [factory setup](runbook-setup.md) first.

## Run

From the repository root:

```bash
npm run check
npm test -- --run tests/integration/preflight.test.ts

PROOF_ID="$(date +%s)"
for scenario in feature bug refactor recovery-success recovery-exhaustion; do
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

The proof launcher supervises the worker process. It prints `FACTORY_PROGRESS` records for snapshot, attempt, trusted-gate, and accepted-stage boundaries. Workspace snapshots also append durable `workspace-snapshot-started` and `workspace-snapshot-completed` events.

Inspect `.runs/evidence/<run-id>/supervisor.json` first. It records the worker exit code or signal, whether the no-progress watchdog fired, and the last progress boundary observed outside the worker. A snapshot exceeding `orchestrationTimeoutSeconds` becomes a normal failed report; a worker that stops sending progress receives `SIGINT` and then `SIGKILL` after the grace period.

Do not reuse or overwrite a stalled run ID. Preserve its workspace, report, events, transcript, and supervisor diagnostic, then start a new run ID. Automatic resume is intentionally unsupported because the in-memory verifier state and immutable acceptance-suite binding must not be reconstructed from untrusted workspace data.

Expected results:

- `feature`, `bug`, `refactor`, and `recovery-success`: `succeeded` with a new output branch and host-owned `artifacts/PR.md`.
- `recovery-exhaustion`: bounded failure accepted by its independent evaluator; no success branch or `PR.md`.
- The base branch remains unchanged in every source repository, and `PR.md` is not committed into an output branch.

Failure evidence is under `.runs/evidence/<run-id>/`; preserved workspaces are under `.runs/workspaces/`.
