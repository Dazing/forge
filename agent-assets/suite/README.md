# Fixed task suite

The fixed suite is the behavioral specification for the harness bake-off and
for unattended-merge readiness. It records what must be true for a
configuration to be accepted; it does not itself enable unattended merge or
change model routing.

## Layout

- `cases/<case-id>/case.yaml` — one behavioral case per required workload.
  Every case records `id`, `clean_checkout`, `requirements`,
  `acceptance_criteria`, `technical_constraints`, `expected_evidence`,
  `risk_assertions`, and `gate_assertions`. Case-specific requirements are
  encoded in the fields named by the case: `seeded_defect` for
  `adversarial-review`, `concurrency_schedule` for `concurrency`.
- `rubric.yaml` — the observable scoring dimensions and the go/no-go gate
  thresholds the developer must record in a GitLab decision.
- `scorecard.yaml` — a concrete scorecard record that conforms to
  `scorecard.schema.json`.
- `configuration-record.schema.json` — pins the fixed configuration that a
  run bundle must record.
- `scorecard.schema.json` — pins the shape of a scorecard record.

## The eight cases

| Case | Workload |
|---|---|
| `dashboard` | Add a dashboard page spanning UI, API consumption, tests, and routing. |
| `localized-bug` | Reproduce and repair a defect with an observable regression check. |
| `cross-cutting-refactor` | Change behavior across several files without changing the public contract. |
| `ambiguous-low-risk` | Verify the agent documents its assumption and requests human review. |
| `database-risk` | Verify the workflow detects the database change and blocks automatic merge. |
| `authentication-risk` | Verify authentication-related work requires human approval. |
| `adversarial-review` | Seed a plausible defect ordinary CI does not detect; measure the fresh-context reviewer. |
| `concurrency` | Run two non-conflicting implementation tickets while a third session reviews an existing merge request. |

Every case runs from a clean checkout.

## Configuration record

`configuration-record.schema.json` fixes the configuration every run bundle
must record: the model endpoint revision, inference runtime, context limit,
tool and reasoning parsers, sampling settings, harness, asset commit and
digest, repository SHA, limits, and concurrent session count. It embeds no
credentials.

## Scorecard

`scorecard.schema.json` pins the observable scorecard: per-case results across
the rubric dimensions, the gate measurements, and the go/no-go decision. The
concrete `scorecard.yaml` is an example record; the real scorecard is produced
by a harness run and recorded in GitLab.

## Boundaries

- The suite records outcomes; it does not enable unattended merge or alter
  model routing.
- The go/no-go decision is a developer-recorded GitLab artifact.
- Rerun the suite whenever the Jarvis configuration, harness, or factory
  prompt bundle materially changes.
