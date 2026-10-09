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
git -C ".runs/proof-inputs/$SCENARIO-$RUN_ID/source" \
  show --stat "factory/proof-$SCENARIO-$PROOF_ID"
```

Expected results:

- `feature`, `bug`, `refactor`, and `recovery-success`: `succeeded` with a new output branch.
- `recovery-exhaustion`: bounded failure accepted by its independent evaluator; no success branch.
- The base branch remains unchanged in every source repository.

Failure evidence is under `.runs/evidence/<run-id>/`; preserved workspaces are under `.runs/workspaces/`.
