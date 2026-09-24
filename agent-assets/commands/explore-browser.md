---
kind: command
name: explore-browser
---
# explore-browser

Run one bounded exploratory browser session against a release deployment.

## Steps
1. Open the test origin with the synthetic account.
2. Drive the release criteria through the UI.
3. Record reproducible actions, expected and observed behavior, and
   screenshot/trace evidence.
4. One retry only for trace capture; a pass-on-retry is flaky and blocks
   pending human classification.

## Output
A structured report that conforms to `schemas/review.schema.json` with the
recorded findings, evidence, and severity.
