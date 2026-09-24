---
kind: skill
name: evidence-driven-review
---
# evidence-driven-review

Reusable guidance for producing an evidence-backed review from a fresh
context.

- Review the diff and CI evidence, not the implementation transcript.
- Every finding is bound to a path and line with evidence and a required
  change.
- Distinguish blocking findings from minor ones. A blocking finding is one
  that makes an acceptance criterion fail or a risk unaddressed.
- Do not raise false blockers: a finding without evidence is a blocker with
  no evidence.
- An `approve` verdict requires every criterion to pass, no blocking finding,
  an identical reviewed SHA, and no unresolved risk.
