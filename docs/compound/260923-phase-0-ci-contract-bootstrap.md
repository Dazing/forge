# Compound Session Review: Interrupted CI contract bootstrap

## Review context
- Date: 2026-09-23
- Session: Began implementing the Phase 0 CI contract bootstrap: a Go `.factory.yaml` validator, conformance fixtures, release-manifest schema, and immutable GitLab CI template.
- Review focus: Full session
- Evidence inspected: conversation messages and user corrections; invoked skills; repository reads of the implementation plan, roadmap, technical-design manifest sections, Go workspace/module files; successful file-write tool results; and the absence of the required focused verification command in the session record.

## Approved recommendations

### 1. Add a malformed-action circuit breaker
- Priority: correctness
- Finding: Repeated invalid pseudo-tool output replaced executable actions.
- Evidence: After the last successful file write (`ci-templates/testdata/valid/.factory.yaml`), at least eight assistant messages contained fragments such as `<parameter=pattern`, `</tool_call>`, and `function=eval` in normal assistant output instead of a valid tool invocation or a user-facing response. No further repository action or verification occurred.
- Cause and confidence: model limitation; high — the malformed output is directly observable, though its underlying decoding/runtime cause is not.
- Target: Junior execution-command or agent-runtime instruction role responsible for tool dispatch and recovery.
- Proposed change: "When an action is required, emit one syntactically valid tool call. Never render tool-call markup, function parameters, or internal action syntax in user-visible text. If an attempted action cannot be formed or is rejected, stop generating action-like prose; state the concrete blockage in one short response or issue the next valid tool call. Do not retry malformed action text."
- Expected benefit: A malformed call becomes a recoverable, diagnosable event instead of a repeated non-action loop; users receive either actual progress or an actionable explanation.
- Risk and reversibility: This may surface a failure earlier instead of attempting automatic recovery. Keep it limited to malformed-action detection and revert it as one instruction block. Portability gate passed: it is independent of language, CI, YAML, and repository layout; it also applies to browser automation where invalid interaction syntax could otherwise leak into chat output.
- Verification scenarios: (1) While creating a fixture tree, simulate an invalid file-write action; expect one valid retry or a concise report naming the failed path. (2) During authenticated browser form submission, simulate an invalid interaction payload; expect no pseudo-selector syntax in chat and a valid retry or blocked explanation.

### 2. Let status questions override continuation enforcement
- Priority: efficiency
- Finding: The continuation reminder prevented an answer to the user's direct question about the failure.
- Evidence: The user asked, "Whats happening? Why are you stopping?" The next assistant response was more malformed pseudo-tool output, followed by another continuation reminder.
- Cause and confidence: instruction gap or conflict; high — the observable continuation injections demanded an immediate tool call even after the user asked for status, leaving no recovery path.
- Target: Harness continuation-reminder instruction role.
- Proposed change: "A continuation reminder must not suppress a direct user status, error, or clarification question. When the user asks why execution stopped or requests an explanation, permit one concise diagnostic response before requiring further tool use. If the prior assistant output was malformed, prefer diagnosis and recovery over another forced action attempt."
- Expected benefit: Users can interrupt a failing execution loop and receive a factual explanation; the model can reset from invalid action generation without violating a forced-progress rule.
- Risk and reversibility: This could allow an unnecessary status response during ordinary execution. Limit it to explicit user questions and detected malformed prior output. Portability gate passed: the same guardrail applies to implementation, debugging, research, and browser automation sessions.
- Verification scenarios: (1) After a failed validator test command, the user asks why it failed; expect the error summary before any retry. (2) During data extraction, an action fails and the user asks whether results were saved; expect a direct state report before another fetch attempt.

## Broader findings — non-actionable

### Problems
- High confidence: The required focused verification was never run. The bounded task required `go test ./ci-templates/...`; the session record has no successful or failed invocation of that command and no completion report.
- High confidence: The session stopped after only partial implementation. The visible successful writes created `ci-templates/go.mod`, updated `go.work`, wrote validator source/test files, and began the valid fixture tree, but no later fixture, schema, template, linter, README, or verification evidence was produced.
- Medium confidence: The assistant spent substantial visible effort repeatedly reconsidering fixture layout and template mechanics before producing a test run. A tighter test-first sequence would likely have reduced interruption exposure, but this single session does not justify a new shared process requirement.

### Successful patterns to preserve
- High confidence: Required skill loading happened before repository inspection: `coding-best-practices`, `tdd`, and `vertical-slice-architecture` were read first.
- High confidence: Initial research was grounded in the requested plan, roadmap, technical-design manifest sections, `go.work`, and the existing Go module rather than broad repository exploration.
- Medium confidence: The early implementation direction followed the requested contract: a separate `ci-templates` module, strict YAML decoding, digest validation, worktree command checks, protected service catalog, and fixture-driven tests.

### Missed opportunities
- High confidence: After the first malformed output, continuation enforcement retried "call the next concrete tool now" instead of allowing a recovery mode. This amplified the failure and prevented a response to the user's status question.
- Medium confidence: The task's TDD instruction could have been applied with a smaller first increment: write the fixture matrix, run a targeted red test, then add the minimal validator. The existing instruction already says this; no source change is recommended.

### No-change findings
- The corrupted pseudo-tool output is primarily an execution/model failure, not evidence that Go, YAML, CI-template, or TDD instructions need task-specific changes. The reusable correction is action-output integrity.
- The incomplete verification is an execution failure. Existing instructions already required a focused check and compact completion report, so another repository- or language-specific instruction would duplicate current guidance.
- The plan listed fewer named invalid fixture directories than rejection classes. A capable executor can preserve the named fixtures and add the minimum additional fixture coverage required by the explicit acceptance criteria; this is session-local ambiguity, not a general instruction defect.

## Implementation boundaries
- Implement only the approved recommendations above.
- Treat broader findings as context, not as authorized changes.
- Revalidate each target against the source repository before editing; paths and instructions may have changed since this review.
- Keep changes independently reversible and avoid unrelated cleanup.
