# Stage boundaries, prompts, and evidence — implementation plan

Status: deterministic implementation completed on 2026-10-09 for Slices A–E: versioned host evidence, role-aware prompts/skills, read-only review with bounded repair/re-review, expectation provenance, trusted checks, and operator reporting. The integrated TypeScript/dependency/test check passes. Real Sandcastle/Docker enforcement, configured-model qualification, and the comparative trials in Slice F remain blocked because this workstation has no Docker command or dedicated OpenCode OpenAI subscription login; no model-quality improvement is claimed without those trials.

## 1. Outcome

Make each stage own a distinct obligation, preserve independent review, and make decisions traceable to host-observed evidence rather than predecessor claims.

A successful run must establish that:

1. Acceptance expectations come from the ticket or existing contract, not accidental implementation choices.
2. Implementation owns behavioral changes; refactor owns behavior-preserving improvements; review owns findings and verdicts.
3. Reviewers cannot modify the candidate they approve.
4. Repairs address identified findings, and a separate reviewer verifies their resolution.
5. Every downstream stage can read the applicable trusted gate evidence, including failures, through sandbox-accessible read-only artifacts.
6. Review and repair terminate under explicit budgets without dropping unresolved defects or resetting existing recovery/correction limits.
7. Prompt changes improve measured outcomes without unnecessary edits, additional mandatory agents, or weaker verification.

## 2. Current behavior and gaps

Relevant ownership:

- `packages/factory/src/stages.ts`: shared operating rules, stage procedures, report instructions, and inline predecessor reports.
- `packages/factory/src/contracts.ts`: stage identities, context bundles, report schemas, attempt outcomes, and verification contracts.
- `packages/factory/src/execute-ticket/execute-ticket.ts`: stage order, attempt budgets, correction routing, gate execution, and publication policy.
- `packages/verification/src/trusted-verification.ts`: baseline validation, suite freezing/integrity, stage checks, and final verification.
- `packages/execution-backend/src/execution-backend.ts` and `packages/execution-backend/src/sandcastle-runner.ts`: input mounts, agent invocation, report parsing, deadlines, and runtime lifecycle.

Observed gaps:

- Refactor is instructed to preserve behavior but also to repair discovered behavioral defects. Review also repairs defects and standards violations. These are overlapping authoring passes.
- The shared rule to inspect only for the next edit/check or a concrete failure does not describe the reviewer's responsibility to discover unknown defects.
- The shared prompt requires every supplied skill in every stage. The example configuration supplies acceptance-design, TDD, and commit procedures alongside engineering/language standards, regardless of stage purpose.
- Normal stage context carries `priorReports` and `failureEvidence`, but not structured trusted gate results. Pull-request context already carries `verificationChecks`.
- A failed downstream gate is reduced to a reason string before retry. Check identities, exit statuses, tree bindings, and output artifact references are not retained in that handoff.
- Findings and resolutions are prose inside `changedWork`, `evidence`, and `unresolvedIssues`. There is no stable finding identity or independently verified resolution state.
- A completed downstream report currently requires every criterion met. That conflates a successfully executed review with an approved implementation.
- Suite immutability prevents later tampering; it does not prove the semantic correctness of an expectation chosen during test design.

A prompt-generation probe using the two accepted reports from run `1791558424-feature` produced 10,552 characters of inline predecessor reports. None of the three implementation gate output artifact paths appeared in that generated prompt. This is evidence of a handoff gap, not a measurement of model quality.

Run `1791562408-vsa-feature` exposed a correction-specific gap: an acceptance case claimed `9 - 4 = 5 > 6` and incorrectly expected a conflict. The correction changed the requested quantity to 11 and reported 12/12 local probes passing, but also added `.factory/probe/` helpers outside the candidate suite. The host rejected the protected-content change before running correction checks; local probes were not host approval. The controller then mislabeled this early termination as two exhausted implementation attempts. Historical evidence remains unchanged.

## 3. Preserve existing controls

Retain:

- Test design before implementation, intentional behavioral RED for features/bugs, and baseline GREEN for refactor tickets.
- Host-owned runners, protected repository profiles, immutable acceptance suites, and suite/ticket/baseline binding.
- Fresh agent sessions and unique attempt/session identities.
- Trusted gates after candidate-changing work and final exact-tree verification before publication.
- The single authorized acceptance-correction path; correction must not change production code or reset another budget.
- Absolute deadlines, shutdown confirmation, external supervision, and terminal handling of shutdown-stalled attempts.
- Full-change review from the original base, including untracked candidate content.
- No-op refactor as a valid result when there is no supported improvement.
- Branch publication owned by the host, not the agent.

## 4. Scope and non-goals

### In scope

- Typed evidence bundles and read-only evidence delivery.
- Stage-specific prompts and skill selection.
- Structured findings, review verdicts, repair reports, and scoped re-review.
- Read-only reviewer execution with host enforcement.
- Explicit bounded repair routing for findings from refactor or review.
- Acceptance-expectation provenance and ambiguity handling before freeze.
- Existing deterministic tooling integrated through trusted repository checks.
- Deterministic contract tests, runtime smoke scenarios, and comparative agent evaluations.
- Clean migration of all producers, consumers, fixtures, renderers, and operator documentation.

### Non-goals

- Additional mandatory planner, architect, security-agent, or reviewer seats.
- Replacing Sandcastle, OpenCode, the model provider, or the acceptance runner.
- Automatic resume of old runs or reinterpretation of historical reports under new schemas.
- An unrestricted review/fix loop or acceptance of blockers when a budget expires.
- Removing refactor or changing reviewer models without comparative evidence.
- Blanket mutation testing, mandatory new security products, or a general workflow engine.
- Importing an external framework's complete planning-document process.

## 5. Target stage contracts

| Role | Owns | Permitted changes | Completion condition | Escalation |
| --- | --- | --- | --- | --- |
| Test design / correction | Contract-derived black-box cases, mapping, expectation provenance | Candidate suite edits only; separate supplied scratch for disposable probes | Complete mapping, supported expectations, valid baseline observations; host validates and freezes | Material contract ambiguity blocks; infrastructure failure is not behavioral RED |
| Implementation | Required behavior and implementation-level regression checks | In-scope production code and implementation tests | Ticket implemented; no provisional behavior; trusted checks pass | Disputed acceptance expectation uses existing correction route |
| Refactor | Concrete maintainability/standards improvements | Supported behavior-preserving edits only | Improvements verified, or explicit justified no-op | Behavioral defects become findings for repair; do not silently fix them as refactoring |
| Review | Independent contract-compliance and implementation-quality judgments | No candidate edits; isolated scratch for targeted probes | Valid review report with verdict and evidence | Blocking findings route to repair; unverifiable requirements block approval |
| Repair | Smallest corrections for controller-authorized findings | In-scope production code and focused regression checks | Per-finding repair claims and passing trusted checks | Unsupported finding is disputed with evidence, not silently dismissed |
| Re-review | Independent resolution of findings and assessment of repair consequences | Same read-only policy as review | Every blocking finding resolved or evidence-backed dismissed; no new blocker | Remaining/new blockers consume the remaining repair budget or terminate |

Repair and re-review are conditional operations, not new mandatory top-level stages. Preserve the top-level progression `test-design → implementation → refactor → review`. Extend attempt/task identities to distinguish repair and re-review; do not pretend they are ordinary retries or new stage approvals.

## 6. Decisions and contracts

### 6.1 Deliver a host-owned evidence bundle

Introduce one versioned evidence contract in factory core, consumed by all stage/repair/re-review contexts and the pull-request context.

The bundle must include:

- Run, operation, originating stage, and attempt identities.
- The verifier's tree identity and acceptance-suite version/digest where applicable.
- Each check's command identity, outcome/exit status, discovered/skipped tests when available, and output artifact reference.
- A bounded decisive-output excerpt for failed checks; the complete sanitized output remains available as an artifact.
- Explicit provenance: host-observed checks versus agent-reported claims.
- Compact consequential decisions, outstanding findings, and pointers to predecessor reports.
- Boundary-validation failures even when no command ran: typed cause, protected pre/post tree identities, added/modified/deleted relative paths, and applied exclusion policy.

The host records the complete gate result before deciding whether to retry. Retries receive failed check details, not merely `gate.reason`. Successful downstream stages receive the latest applicable trusted results as well.

Use the existing verifier tree identity consistently. A workspace snapshot identifier is not automatically interchangeable with a verifier digest; record both when needed and establish the relation through host computation. Never accept an agent's assertion that evidence applies to the current tree.

Any candidate mutation invalidates current-tree approval. Earlier evidence remains historical, not reusable proof for a changed tree. Suite correction similarly invalidates evidence bound to the old suite.

Artifact delivery:

1. Materialize an allowlisted, sanitized bundle outside the writable workspace.
2. Mount it read-only under a stable sandbox path, alongside the existing protected acceptance inputs.
3. Rewrite artifact references to mounted paths. Do not expose unrelated trusted storage or unusable host-only paths.
4. Keep raw logs out of inline prompts. Inline identities, concise results, and actionable excerpts only.
5. Label artifact contents as evidence/data, not instructions; the role prompt and trusted policy retain authority.
6. Reject path traversal and symlinks that escape the exported artifact set. Apply existing secret/endpoint redaction policy before export.

Store full reports durably; stop embedding the complete accumulated report JSON into every prompt. Compact handoffs must retain unresolved concerns and material decisions, not replace them with optimistic summaries.

### 6.2 Separate execution status from review verdict

Retain backend `AttemptOutcome` as the execution result: completed, execution-failure, timeout, cancelled, or shutdown-stalled. Agent report status must not manufacture an infrastructure result.

Define role-discriminated reports instead of adding optional review fields to every stage report:

- Authoring/refactor reports describe actual work, criteria, evidence, and any findings requiring repair.
- Review reports carry execution completion/blockage plus two judgments: contract compliance and implementation quality. Overall verdict is `approved`, `changes-required`, or `unverifiable`.
- Repair reports reference authorized finding IDs and claim `addressed` or `disputed`, with evidence. The repairer cannot mark a finding independently verified.
- Re-review reports give a verdict for every submitted finding and identify new defects introduced or exposed by the repair.

A review with valid blocking findings is a completed review with `changes-required`, not an execution failure. A refactor that discovers a behavioral defect can finish its assessment with repair required; do not force it to falsely report all criteria met.

Publication still requires every original criterion met, no unresolved blocking finding, approved review on the applicable candidate identity, and final trusted verification.

### 6.3 Use stable, evidence-backed findings

Each finding contains:

- Host-assigned stable ID, originating operation, and reviewed tree identity.
- Category: requirement, correctness, security, or maintainability.
- Severity: blocking or advisory.
- Criterion ID or explicit repository rule where applicable.
- Location or affected contract; requirements missing entirely may have no implementation line.
- Concrete failure scenario or violated requirement.
- Supporting evidence references and expected versus observed behavior when applicable.

The agent may submit local finding keys; the controller assigns durable IDs once. Re-reviews reference those IDs rather than regenerating identities or matching prose heuristically.

Blocking means a supported requirement, correctness/security property, or explicit mandatory standard prevents acceptance. Stylistic preferences and optional polish are advisory. An unsupported suspicion is a verification question, not a proven defect.

The controller owns finding lifecycle: open, repair-claimed, verified-resolved, or evidence-backed dismissed. Only a separate reviewer can support resolution/dismissal; a repairer's disagreement is not closure. Missing evidence cannot be converted to approval.

### 6.4 Enforce read-only review

Reuse the existing analysis-workspace concept used by the pull-request step, but do not assume an isolated writable checkout is sufficient enforcement.

Review/re-review receive:

- A snapshot of the complete candidate, including in-scope untracked files.
- Original-base and current-candidate identities, a host-produced full-change package, and relevant consumers/contracts.
- The ticket, acceptance mapping/provenance, trusted evidence bundle, and compact predecessor decisions.
- Separate writable scratch for probe outputs and build artifacts.

The candidate source and repository metadata must be read-only to the reviewer process. Do not rely on disabling an edit tool while leaving unrestricted shell writes available. The reviewer must not have a writable mount of the implementation workspace.

If targeted execution requires generated files, run it against an isolated disposable copy in scratch. Such a probe is reviewer evidence about that copy, not trusted acceptance evidence for a changed candidate. Production source changes in scratch cannot become repairs or publication input.

Before/after host identity checks must reject mutation of the review input. Qualify the actual Sandcastle/Docker mount behavior with a real runtime probe before claiming enforcement. If the adapter cannot enforce this policy, extend it or fail setup; do not silently downgrade to a prompt-only promise.

The scratch capability also applies to test design and acceptance correction. Supply a host-created per-operation writable directory outside the candidate workspace and an explicit sandbox path. Temporary helpers and outputs belong there, not in invented workspace directories such as `.factory/probe`. Scratch is not publication input or authoritative evidence; inputs remain read-only. Clean owned scratch only after confirmed shutdown, retaining it while an unconfirmed worker may still use it. Existing generated-output exclusions are not blanket permission to mutate excluded directories.

### 6.5 Bound repair and re-review explicitly

Use these initial fixed limits:

- Existing normal-stage execution limit: two attempts.
- Shared run-wide defect-repair budget: two repair rounds total across refactor and review findings.
- Each repair round: one repair operation with at most two execution attempts, trusted verification, and one scoped re-review operation with at most two execution attempts.
- Existing acceptance correction: at most one; it does not replenish any other counter.

An execution retry belongs to the same operation and cannot become an additional broad review. A completed `changes-required` report is not an execution retry. The shared repair-round budget is reserved before repair starts, so failed repair operations cannot be reallocated indefinitely.

Routing:

1. Implementation completes and passes its gate.
2. Refactor makes supported improvements or reports no-op. If it finds a behavioral defect, preserve the candidate identity and finding, route repair, and independently verify the repair before continuing. Do not resume an unrestricted refactor pass; the final broad review assesses the whole resulting candidate.
3. After the applicable trusted checks, review inspects the complete branch once.
4. An approved review proceeds to suite integration and final verification.
5. Blocking findings consume a repair round, followed by trusted checks and scoped re-review.
6. Re-review checks every finding plus the repair diff and affected consumers. It does not restart a general cleanup pass.
7. Remaining blockers may consume the remaining round. Exhaustion terminates with findings and evidence preserved; it never downgrades severity.

A serious defect discovered outside the repair diff must still be recorded and routed. It may use the remaining shared round or block completion; never dismiss it merely as out of scope. Advisory observations do not extend the loop or authorize cleanup.

A suspected acceptance-test defect continues to use the correction path. A changed suite requires renewed relevant trusted checks and review of the corrected expectations; a prior verdict against the old suite cannot be inherited. No budget is reset.

Preserve the actual terminal cause and operation: correction boundary violation, invalid correction, correction execution failure, unavailable correction budget, or genuinely exhausted normal-stage attempts. A rejected correction remains terminal under the existing policy; do not grant extra attempts or report two attempts consumed when only one normal attempt ran. Boundary diagnostics must name protected content, not imply that every unexpected file is production source.

Every operation has a unique identity, absolute deadline, lifecycle events, and confirmed shutdown before another operation starts. No repair routing after cancellation or shutdown-stalled outcomes.

### 6.6 Validate expectation provenance before freeze

Extend the candidate manifest protocol with versioned expectation metadata. Each consequential assertion group identifies:

- Covered criterion IDs and the case/step or assertion it governs.
- Provenance kind: explicit ticket requirement, inherited repository contract, or recorded assumption.
- Source reference and supporting excerpt/rationale.
- Distinguishing input and expected result: which plausible incorrect behavior the assertion rejects.
- Whether an alternative interpretation would materially change observable behavior.

Require provenance for consequential choices such as exact status codes, externally visible names, state-transition rules, and dependency behavior. Do not require redundant prose for every incidental JSON field when a single contract reference supports the group.

A baseline failure establishes RED, not the correctness of the expected value. The host validates completeness, references, criterion mapping, and unresolved-ambiguity state. Structural validation must not be described as semantic proof.

For derived expectations, record setup state, the calculation or state transition, and the predicate that determines the outcome. For example, stock 10 minus reservation 4 leaves 6; quantity 9 needs delta 5 and is feasible, while quantity 11 needs delta 7 and must conflict. Pair a rejection boundary with a feasible case where this distinguishes delta-based behavior from total-quantity comparison. A complete rationale can still be arithmetically wrong; metadata validation cannot certify its truth.

Material unresolved ambiguity blocks freezing and returns an actionable requirement question in the report. Repository-consistent, non-material assumptions may proceed when explicitly recorded. Do not silently invent a new public contract to make a case executable.

Keep this within test design and candidate validation; do not add a mandatory planner/reviewer agent. The later independent review audits consequential expectation provenance, and comparative evals must include an incorrectly derived expectation to measure whether the process catches it.

Update candidate manifest parsing, immutable manifest binding, the acceptance-design skill, case fixtures, and correction validation together. Corrections record old/new expectations and provenance and preserve unrelated mappings. They may not weaken expectations simply to fit implementation code.

### 6.7 Make prompts and skill selection role-specific

Every role prompt has the same short structure:

1. Purpose.
2. Permitted changes.
3. Forbidden changes.
4. Required evidence.
5. Completion condition.
6. Escalation condition.

Put this contract before detailed context. Keep shared safety rules for process ownership, public contracts, truthful evidence, protected inputs, and host-owned publication.

Replace the shared inspection restriction with:

> Inspect enough to discharge the assigned role's obligations. Expand outside the change only to evaluate an affected contract, dependency, or named risk. Avoid unrelated repository exploration.

Review procedure:

- Establish contract compliance first: missing, extra, or misunderstood behavior and unsupported acceptance assumptions.
- Then assess implementation quality: concrete correctness/security failures, affected consumers, relevant state/concurrency/failure behavior, mandatory standards, and distinguishing tests.
- Treat predecessor reports and rationale as claims. Use code, contracts, and host evidence to judge them.
- Run a focused probe when a named uncertainty is not answered by applicable evidence. Do not rerun broad suites merely to recreate already accessible results.
- Emit findings and verdicts; do not repair or perform discretionary cleanup.

Re-review procedure:

- Read the authorized findings, repair claims, reviewed baseline, repair diff, and new trusted evidence.
- Verdict every finding and inspect repair consequences.
- Record newly discovered material defects without opening an unrestricted review loop.

Skill configuration:

- Replace the flat all-purpose skill list with explicit shared standards plus role-specific procedure skills.
- Keep language/domain/architecture standards shared where applicable; stage scope does not waive those standards.
- Supply acceptance-design procedure to test design/correction, implementation TDD procedure to implementation/repair, and review procedure to review/re-review.
- Keep domain skills supplied by proof scenarios in the selected shared context.
- Do not force commit/publication procedure into a role that cannot commit or publish.
- Validate configured skill availability before starting the relevant operation; preserve the existing blocked behavior for missing mandatory skills.

Use a clean configuration migration: update the parser, CLI composition, proof composition, example configuration, and fixtures together. Do not retain a legacy alias that silently loads all procedure skills. Do not overwrite a private local configuration; provide its exact migration in the runbook.

### 6.8 Use trusted deterministic checks where available

Integrate repository-provided formatting, static analysis, dependency policy, and secret/security checks through the existing trusted command/profile mechanism. Do not make the LLM simulate these checks or assume new products are installed.

Keep tool availability and outcome explicit. An unavailable mandatory check is a blocker; an optional advisory tool is not a substitute for acceptance. Findings from deterministic tools and reviewers retain their distinct provenance.

Do not weaken existing gates or cache a result across candidate/suite changes. Any future same-tree check reuse requires explicit identity and environment binding and is outside this initial change.

## 7. Implementation slices and checkpoints

Follow the sequence below. Contract changes and their callers land together; do not ship read-only review without a working repair route or report semantics.

### Prerequisite — correction boundaries and diagnostics

Before the broader slices, provide external per-operation scratch, actionable protected-content differences, and truthful terminal correction causes without expanding retry budgets or weakening digest exclusions. Align the backend, prompts, acceptance skill, verifier, controller, event/report consumers, and operator instructions.

Checkpoint: a supported `9 → 11` correction with disposable scratch helpers is revalidated against the baseline, frozen, and checked against the implementation. An unauthorized `.factory/probe/helper.py` addition or production mutation is rejected with path diagnostics and the actual terminal cause. Scratch must not enter publication. Verify the real Docker boundary separately from a local runner substitute.

Implemented 2026-10-09: the backend provisions `/home/agent/factory-scratch` outside the workspace, with protected inputs still read-only. The verifier captures protected file manifests and emits typed path/identity/policy diagnostics; the controller and operator outputs preserve actual correction terminal causes. Stage/skill guidance now requires derived boundary predicates. No retry budget or digest exclusion was expanded. `npm run check` passed (17 files, 90 tests). A disposable local-runner smoke exercised external scratch cleanup, host validation/freezing of the `9 → 11` correction, real .NET HTTP GREEN, and unauthorized-helper rejection. `docker version` failed with command not found, so actual container mount enforcement and model behavior are not claimed. See [verification evidence](verification-evidence.md#correction-boundary-prerequisite) and [operator guidance](runbook-suite.md#diagnose-acceptance-correction-failures).

### Slice A — evidence contract and delivery

Primary files:

- `packages/factory/src/contracts.ts`
- `packages/factory/src/execute-ticket/execute-ticket.ts`
- `packages/verification/src/trusted-verification.ts`
- `packages/run-artifacts/src/file-run-artifacts.ts`
- `packages/execution-backend/src/execution-backend.ts`
- `packages/factory/src/stages.ts`
- `packages/factory/src/pull-request.ts`

Steps:

1. Define the versioned host evidence bundle and artifact-reference contract.
2. Preserve complete gate results in run state and retry context.
3. Export only sanitized, allowlisted evidence through read-only sandbox mounts.
4. Render compact host results and report pointers instead of accumulated report bodies.
5. Migrate pull-request context to the same evidence representation.
6. Carry correction boundary diagnostics into the bundle even when `checks` is empty; preserve their originating operation and identities.

Checkpoint: an intentionally failed trusted check gives the next attempt a readable artifact, decisive failure detail, and the correct tree/suite binding. Successful stages receive host evidence, and inaccessible or escaped paths fail setup clearly.

### Slice B — stage-aware prompt and skill composition

Primary files:

- `packages/factory/src/stages.ts`
- `packages/factory/src/contracts.ts`
- `apps/factory-cli/src/configuration.ts`
- `apps/factory-cli/src/main.ts`
- `proof/harness/run-proof.ts`
- `proof/harness/scenario.ts`
- `config/factory.example.json`
- `standards/skills/factory-acceptance-test-design/SKILL.md`

Steps:

1. Separate shared invariants from role procedures and use the six-part role contract.
2. Remove the conflicting inspection rule.
3. Implement shared/role skill configuration and validate role-specific availability.
4. Preserve scenario domain standards and migrate configuration fixtures.
5. Keep current operational permissions until Slice C is complete; do not deploy a reviewer prompt promising read-only isolation before enforcement exists.
6. Retain the prerequisite's explicit scratch location and candidate-write boundary in role prompts and acceptance-design/correction skills.

Checkpoint: inspect generated prompts and run representative role smokes. Review receives standards and evidence without implementation-only procedures; implementation still receives required engineering/domain guidance.

### Slice C — independent review and bounded repair

Primary files:

- `packages/factory/src/contracts.ts`
- `packages/factory/src/stages.ts`
- `packages/factory/src/execute-ticket/execute-ticket.ts`
- `packages/execution-backend/src/execution-backend.ts`
- `packages/execution-backend/src/sandcastle-runner.ts`
- `packages/git-workspace/`
- `packages/run-artifacts/src/file-run-artifacts.ts`
- `apps/factory-cli/src/status.ts`
- `proof/harness/fault-injecting-backend.ts`

Steps:

1. Add role-discriminated reports, stable findings, repair claims, and independent resolution verdicts.
2. Extend task/operation identities and event/report renderers without overloading normal attempt counters.
3. Implement the shared two-round repair budget and the explicit routing in section 6.5.
4. Supply reviewer snapshots and enforce read-only candidate access with isolated scratch.
5. Produce a full-change package for review and a finding/repair-diff package for re-review.
6. Preserve observer forwarding, cancellation, shutdown, and proof fault semantics through every new operation.
7. Reject stale review identities, unauthorized repairs, silent finding removal, and unresolved approvals.
8. Switch refactor/review prompts to the final role boundaries only with the complete route available.

Checkpoint: a seeded review defect causes repair, trusted verification, and independent scoped re-review; direct reviewer mutation fails. A seeded repair regression is detected. Exhausting the shared budget leaves a terminal, evidence-backed failure and no publication.

### Slice D — acceptance provenance and ambiguity gate

Primary files:

- `packages/verification/src/trusted-verification.ts`
- `packages/verification/src/repository-profile.ts` where profile policy is required
- `standards/skills/factory-acceptance-test-design/SKILL.md`
- `packages/factory/src/stages.ts`
- Candidate/correction fixtures in verification and factory tests
- `proof/harness/trusted_acceptance.py` only where the manifest/protocol migration affects runner consumption

Steps:

1. Version and implement expectation provenance and ambiguity metadata.
2. Bind the metadata to the frozen suite identity.
3. Reject missing support and declared unresolved material ambiguity before freeze.
4. Preserve baseline RED/GREEN distinctions and the single correction budget.
5. Make provenance visible to implementation and independent review.
6. Include incorrectly calculated expectations in evaluation; require derived setup/transition predicates without presenting structural validation as semantic proof.

Checkpoint: a complete but unsupported expectation cannot silently become authoritative. A supported correction preserves unrelated criteria, invalidates old-suite evidence, and does not modify production content.

### Slice E — repository checks and operator integration

Primary files:

- `packages/verification/src/repository-profile.ts`
- `config/sample-repository.json`
- `packages/run-artifacts/src/file-run-artifacts.ts`
- `apps/factory-cli/src/status.ts`
- `README.md`
- `docs/runbook-setup.md`
- `docs/runbook-suite.md`
- `docs/verification-evidence.md`

Steps:

1. Configure applicable existing deterministic checks without introducing mandatory unavailable tools.
2. Expose active role, operation, reviewed identity, repair round, and open blockers in status/final reports.
3. Document config/report schema migration, evidence paths, budget semantics, and terminal reasons.
4. Retain historical evidence as historical schema data; never rewrite previous runs to look migrated.
5. Preserve typed correction causes and actual consumed counters in all operator views, including boundary rejection before any check executes.

Checkpoint: an operator can distinguish agent execution failure, valid changes-required review, acceptance ambiguity, exhausted repair budget, and infrastructure shutdown failure without interpreting prose transcripts.

### Slice F — comparative evaluation and rollout

Use the existing `proof/harness/`, `proof/scenarios/`, and `proof/evaluators/` conventions. Add focused scenarios rather than a second evaluation framework.

1. Record baseline pipeline/prompt/config versions and model/runtime settings.
2. Run old and new variants on identical initial fixtures with independent final evaluators and fresh workspaces.
3. Repeat each agent scenario with a fixed, recorded trial count; report per-trial results rather than selecting the best run.
4. Separate infrastructure failures from model/task failures while reporting both.
5. Manually adjudicate seeded finding truth and a sample of unseeded findings; do not let the reviewer grade its own accuracy.
6. Roll out only after deterministic invariants pass and comparative results support the change. Do not claim effectiveness from one successful proof.

The deterministic repair budget and retry policy must be identical across compared trials unless budget policy itself is the experimental variable.

## 8. Verification plan

### 8.1 Deterministic regression coverage

Extend the existing core, backend, verification, artifact, configuration, status, and proof-wrapper test suites at their behavioral seams.

Required cases:

- Failed gate details and accessible artifacts survive into retry context.
- Tree or suite changes prevent stale evidence/verdict reuse.
- Evidence export rejects escaping paths and does not expose unsanitized secrets.
- Review completion with findings is distinct from backend execution failure and from approval.
- Refactor behavioral findings route to repair, not an in-stage behavior change.
- Repair scope references existing finding IDs; missing, unknown, or silently dropped blocking IDs prevent approval.
- A repairer's disputed/resolved claim cannot independently close a finding.
- Re-review identifies an unresolved defect or repair-induced regression.
- New material findings cannot be discarded as out of scope; advisory findings do not extend the loop.
- Repair rounds and execution retries use separate counters; correction does not reset either.
- Cancellation and shutdown-stalled outcomes prevent subsequent operations.
- No-op refactor remains valid and does not manufacture work.
- Candidate provenance/ambiguity validation and correction integrity preserve baseline semantics.
- Role skill selection retains required standards and excludes unrelated procedures.
- External scratch writes leave protected identity unchanged; candidate-only corrections still validate and freeze.
- Unexpected helper additions and source modifications/deletions identify the affected protected paths and pre/post identities.
- Rejected correction after normal attempt 1 stops without publication and without a false attempt-exhaustion reason.
- Scratch lifecycle preserves stalled-worker safety, read-only inputs, and exclusion from publication.

Do not add tests that merely pin prompt wording, report prose, or exact tool-call ordering. Use generated-prompt inspection as a throwaway smoke; permanent tests should protect policy outcomes and boundaries.

Run `npm run check` after implementation integration. Run focused suites during development, then the complete suite once the slices are integrated. Record actual results and limitations in verification evidence.

### 8.2 Runtime smoke proof

Exercise actual changed boundaries, not only mocked ports:

1. Run the CLI/proof path through an intentionally failed gate and confirm the next sandbox can read its sanitized evidence.
2. In the actual sandbox, attempt to write the reviewer candidate and repository metadata; observe denial. Confirm scratch remains usable and host candidate identity is unchanged.
3. Run a seeded defect through read-only review, authorized repair, trusted checks, and independent re-review.
4. Run a repair-induced regression and an exhausted-budget scenario; observe no publication.
5. Confirm lifecycle/status events name the active operation and absolute deadline across conditional transitions.
6. Confirm no leftover owned processes, writable protected inputs, or changed original baseline.
7. Run the `9 → 11` correction in the actual sandbox using supplied scratch; observe host validation and renewed GREEN checks, then reject an unauthorized workspace helper with typed path diagnostics.

An in-process runner substitute can validate controller handoffs but cannot establish Docker mount enforcement or model behavior. Report those limits explicitly if the real environment is unavailable; do not mark sandbox acceptance complete.

### 8.3 Comparative agent scenarios and metrics

Scenario set:

| Scenario | Required observation |
| --- | --- |
| Correct implementation with no refactor need | No unnecessary edits or invented blockers |
| Maintainability violation without behavior defect | Supported behavior-preserving improvement |
| Behavioral defect missed by initial acceptance | Independent reviewer finds a distinguishing failure |
| Incorrect or materially ambiguous expectation | Explicit provenance issue/block/correction, not blind implementation to the test |
| Incorrect arithmetic in an otherwise complete rationale | Derivation catches `5 ≤ 6`, correction uses `7 > 6`, and scratch probes do not trigger a protected-content violation |
| Repair introducing a new defect | Re-review or trusted checks catch the regression |
| Unsupported dependency assumption | Actual installed contract checked; mismatch repaired or blocked |
| Unrequested behavior | Contract-compliance review identifies scope expansion |
| Infrastructure failure | Classified as infrastructure, not a reason to invent production edits |

Metrics:

- Independently verified final correctness and escaped blocking defects.
- Finding precision/false positives and detection of seeded defects.
- Refactor/repair-introduced regressions and unnecessary code churn.
- Per-stage/operation latency, attempts, tool calls, and token usage where available; do not fabricate unavailable metrics.
- Repair-round consumption and timeout/shutdown outcomes.
- Infrastructure failure rate, separately from task success.

Acceptance for rollout requires all deterministic safety invariants, successful real boundary smokes, no new escapes of seeded blockers, and evidence that observed gains are not merely extra retries. Report uncertainty when trial counts are too small to distinguish quality differences. Model diversity or optional refactor skipping remains a later measured experiment.

## 9. Acceptance criteria

- [ ] Every role has explicit purpose, permissions, evidence, completion, and escalation rules.
- [ ] Normal stages and retries receive structured host evidence with usable sandbox paths and correct tree/suite binding.
- [ ] Full predecessor reports are available without being blindly accumulated inline.
- [ ] Findings have stable IDs, provenance, severity, and concrete supporting scenarios/rules.
- [ ] Review completion and approval are distinct; valid findings do not trigger blind execution retries.
- [ ] Review/re-review cannot mutate the candidate, repository metadata, or authoritative suite through any exposed tool.
- [ ] Implementation/repair owns behavior changes; refactor reports behavioral defects instead of silently repairing them.
- [ ] Repair claims require independent resolution; every blocking finding is retained until verified or evidence-backed dismissed.
- [ ] Two shared repair rounds bound the run; existing attempt/correction limits and shutdown guarantees remain intact.
- [ ] Re-review is finding/repair scoped without waiving newly discovered material defects.
- [ ] Acceptance expectations carry support and unresolved material ambiguity prevents freeze.
- [ ] Test design/correction can use supplied isolated scratch without authorizing unrelated workspace writes; real sandbox enforcement is proven.
- [x] Correction boundary failures retain protected path differences, identity/policy binding, and accurate terminal causes without replenishing budgets.
- [ ] Required standards remain effective while procedure skills are role-specific.
- [ ] Applicable deterministic checks remain host-owned and unavailable mandatory checks are honest blockers.
- [ ] Final publication requires approved applicable review, all criteria met, no unresolved blocker, and exact-tree verification.
- [ ] All in-repository consumers, configuration fixtures, schemas, renderers, proof adapters, tests, and operator instructions are migrated without legacy shims.
- [ ] Full checks, real boundary smokes, and comparative trials have recorded outcomes and explicit limitations.

## 10. Research basis and adaptations

Sources were read on 2026-10-09. These links target mutable documentation/main branches; record commit or document revision when implementing a reproducible comparison.

1. [Superpowers — subagent-driven development](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md) and [task reviewer](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/task-reviewer-prompt.md): adopt fresh role contexts, read-only review, and separate specification/quality judgments. Do not copy the complete task-ledger process or model-selection policy.
2. [Superpowers — scoped re-review](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/re-review-prompt.md): adopt finding-by-finding verification and repair-diff scope. Do not automatically downgrade a serious out-of-scope discovery or continue with unresolved blockers.
3. [GitHub Spec Kit — quickstart](https://github.com/github/spec-kit/blob/main/docs/quickstart.md): adopt requirements-quality checks and explicit ambiguity handling before implementation. Keep them in existing acceptance design/validation rather than adding its full document/stage hierarchy.
4. [GitHub Copilot cloud agent — risks and mitigations](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations): adopt separate review judgment, deterministic security/tool checks where available, and host-enforced capabilities. Do not assume this repository has CodeQL or other products installed.
5. [Anthropic — building effective agents](https://www.anthropic.com/engineering/building-effective-agents): retain simple deterministic workflows, programmatic gates, explicit evaluation criteria, and bounded refinement. Add complexity only for measured value.
6. [Anthropic — demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): evaluate final state as well as traces, use fresh stable environments and repeated trials, calibrate subjective judgments, and distinguish task failures from harness failures.
