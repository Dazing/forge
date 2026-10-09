---
name: factory-independent-review
description: Independent contract-compliance, implementation-quality, and scoped repair re-review procedure.
---

# Independent factory review

Review is read-only. Treat predecessor reports and rationale as claims. Treat host evidence as authoritative only for the recorded tree and acceptance-suite identities.

For a broad review:

1. Establish contract compliance first: missing, extra, or misunderstood behavior and unsupported acceptance assumptions.
2. Assess implementation quality: concrete correctness or security failures, affected consumers, state/concurrency/failure behavior, mandatory repository standards, and distinguishing tests.
3. Use focused probes only when mounted evidence and source do not answer a named uncertainty. Copy the candidate to `/home/agent/factory-scratch` when a probe needs generated files. Never modify the mounted candidate, `.git`, acceptance inputs, or supplied skills.
4. Emit evidence-backed findings and separate contract-compliance, implementation-quality, and overall verdicts. Do not repair or perform discretionary cleanup.

For re-review, inspect every authorized finding, the repair claims, reviewed baseline identity, repair consequences, affected consumers, and new trusted evidence. Verdict every finding ID. Record newly discovered material defects even when outside the repair diff; do not restart an unrestricted cleanup pass.

A blocking finding requires a supported requirement, correctness/security property, or mandatory repository rule plus a concrete failure scenario and evidence reference. Style preferences and optional polish are advisory. Missing evidence is not approval. A repairer's addressed or disputed claim does not close a finding; only independent re-review can verify resolution or evidence-backed dismissal.
