# Software Factory POC — Implementation Plan

Status: proposed implementation design; no runtime compatibility or product behavior has been verified yet.

Product contract: [Software Factory POC brief](software-factory-poc-brief.md).

## 1. Outcome and scope authority

Deliver a manually invoked command that takes one Markdown ticket, runs fresh-context test-design, implementation, refactoring, and review agents against a controlled .NET 10 repository, and returns a committed solution branch or an explicit failure report.

The product brief controls this POC. The root README describes a broader GitLab factory; GitLab integration, queues, parallel tickets, automatic merge/release, hardware decisions, and restart recovery are not dependencies of this implementation.

This plan adds module boundaries and delivery details, not additional product scope. The inventory-reservation sample and the test-correction budget below are proposed implementation choices from the brief, not already validated product behavior.

## 2. Architecture decision

Use a modular application in one repository and one orchestrator process. Separate policy from external mechanisms with small consumer-owned contracts. Do not build microservices, a generic workflow engine, a plugin registry, an event bus, or a multi-provider framework.

Prefer TypeScript if the Sandcastle compatibility spike succeeds. If another runtime makes a different host language materially simpler, retain these logical boundaries in that language. Do not start implementing the TypeScript package layout until that decision is made.

Implement one real execution backend. Replaceability means an alternative can satisfy a documented contract without rewriting workflow policy; it does not mean shipping multiple backends in the POC.

### Dependency rules

- The CLI is the composition root: it constructs adapters, validates configuration, and starts the run.
- The factory feature owns workflow state, stage order, retry budgets, acceptance decisions, and the single-ticket execution capability.
- External adapters implement factory-owned ports. The factory imports no vendor SDKs, Git/process implementations, or container APIs.
- Stage definitions supply instructions and required report shapes. They cannot launch other stages, retry themselves, or decide final run success.
- Adapters never import one another. The composition root supplies any shared lower-level driver explicitly.
- Tests are colocated with their owner except cross-module contract tests and end-to-end proof scenarios.
- The sample application has no dependency on the factory and can build and run independently.
- No catch-all `shared`, `utils`, or global mutable context package. Promote a helper only after a concrete shared need exists.

Treat `execute-ticket` as a capability slice. Git, report serialization, and sandbox execution are infrastructure modules, not artificial technical-layer slices. Workflow nesting belongs in the factory execution flow, never in stage prompts.

## 3. Proposed repository structure

The following is the target layout if TypeScript is selected. Create directories when their implementation lands, not as empty scaffolding.

```text
apps/
  factory-cli/
    src/
      main.ts                    # Composition root and exit behavior
      configuration.ts           # Host configuration and secrets references
packages/
  factory/
    src/
      index.ts                   # Small public application surface
      execute-ticket/
        execute-ticket.ts        # Explicit sequential workflow
        transitions.ts           # Attempt budgets and legal transitions
        gates.ts                 # Evidence-based success policy
        execute-ticket.test.ts
      stages/
        test-design/
        implementation/
        refactor/
        review/                  # Instructions and stage-local report requirements
      contracts/                 # Owned input/output values and report schemas
      ports/                     # External capabilities required by factory
  execution-backend/
    src/                         # Only the selected runtime/sandbox implementation
  git-workspace/
    src/                         # Isolated clone, branch, snapshots, final publication
  verification/
    src/                         # Trusted runner and acceptance-suite protection
  run-artifacts/
    src/                         # Filesystem evidence store and report rendering
samples/
  inventory-reservations/
    AGENTS.md
    src/
    tests/
    fixtures/                    # Explicit baseline variants, not committed solutions
proof/
  tickets/
    feature.md
    bug.md
    refactor.md
    recovery.md
  scenarios/                     # Baseline, model config, checks, fault selection
  harness/                       # Independent evaluator and deterministic fault injection
config/
  factory.example.json
  sample-repository.json         # Trusted commands and fixture selection
standards/
  skills/                        # Reviewed skill files supplied to agents
containers/
  agent/                         # Selected runtime plus pinned .NET 10 SDK
  verifier/                      # Trusted verification image/configuration
  orchestrator/                  # Only if containerized invocation is delivered
tests/
  contracts/
  integration/
docs/
  software-factory-poc-brief.md
  software-factory-poc-implementation-plan.md
  runtime-compatibility.md        # Created with actual spike evidence
.runs/                           # Ignored run evidence and isolated workspaces
```

Use workspace packages with explicit exports rather than deep cross-package imports. Keep related small contracts in the factory package; do not create a package per interface or stage. The execution backend remains one cohesive package because runtimes may own their sandbox lifecycle. Split runtime and sandbox implementations later only if the selected SDK actually exposes independently replaceable seams.

## 4. Module ownership and contracts

Operation names below describe responsibilities; finalize language-specific signatures after the spike. All blocking operations accept cancellation and a deadline where applicable. Provider-specific handles remain private to their adapter.

| Module | Owns | Public contract | Must not own |
|---|---|---|---|
| Factory | Run state, stages, gates, recovery decisions | `executeTicket(request, dependencies)` returning a terminal run outcome | SDK calls, shell commands, filesystem layout |
| Execution backend | Fresh agent session, sandbox lifecycle, tool transcript capture, provider error translation | `runAttempt(request)` returning execution outcome, report candidate, and evidence references | Retry policy, acceptance verdict, Git publication |
| Git workspace | Isolated working repository, designated branch, base identity, snapshots and final branch publication | `prepare`, `snapshot`, `publishBranch`, `disposeExecutionResources` | Stage policy, test interpretation, merges into the base branch |
| Verification | Authoritative acceptance bundles, trusted check execution, candidate promotion validation | `validateCandidate`, `freezeSuite`, `runChecks`, `validateCorrection` | LLM conversations or stage retry decisions |
| Run artifacts | Append-only evidence, host-owned manifests, readable final report | `record`, `attach`, `finalize` | Workflow state transitions or resume behavior |
| CLI/configuration | Argument parsing, trusted configuration, dependency construction, terminal output | One run command with documented exit codes | Duplicated orchestration rules |

### Boundary values

- `Ticket`: original Markdown, stable acceptance-criterion IDs, task kind, and content digest. Require a documented Markdown structure; do not add an LLM ticket-parser stage.
- `RunRequest`: ticket, repository profile, base commit, branch name, model settings, stage limits, and standards bundle references.
- `AttemptRequest`: run/stage/attempt identity, workspace reference, explicit context bundle, permitted mounts, deadline, and required result schema. No previous conversation or reusable session ID.
- `AttemptOutcome`: completed, execution failure, timeout, or cancelled; report candidate; transcript and command evidence references. Completed does not mean accepted.
- `StageReport`: completed, blocked, or suspected test defect; criterion verdicts; evidence references; changed work summary; unresolved issues. Unknown/missing criteria cannot imply success.
- `CheckResult`: trusted command identity, exit code, parsed test outcomes where supported, captured output, tested tree/snapshot identity, and acceptance-bundle digest.
- `RunOutcome`: succeeded, failed, or cancelled; branch/base/final identities; stage attempts; criteria verdicts; report location; terminal reason.

Validate agent-produced reports at the boundary. Keep the schema source and runtime validation together; derive types rather than maintaining duplicate definitions. Missing or malformed reports are failed attempts, not a reason for an extra hidden model call.

### Replacing modules safely

| Change | Expected edit surface |
|---|---|
| Sandcastle-based backend to another runtime | Execution backend, its contract tests, image, composition wiring |
| vLLM model or endpoint | Configuration; backend compatibility evidence if tool behavior changes |
| Review instructions | Review stage assets and relevant behavior scenarios |
| Git publication strategy | Git workspace adapter and branch-preservation integration tests |
| Check implementation or sample stack | Verification adapter/profile and corresponding fixtures; no retry-policy changes |
| Report presentation | Run-artifacts renderer; no workflow changes |
| Recovery policy | Factory transitions and transition tests; no vendor SDK changes |

Enforce allowed dependencies with the selected toolchain's package/import rules. Prohibit deep imports, cycles, and vendor dependencies in the factory package. Keep third-party types out of public factory contracts. A replacement must pass the same behavioral contract checks, not merely compile.

## 5. State, handoffs, and recovery

Use an explicit sequential loop and typed state, not a configurable workflow DSL.

Normal progression:

`preflight → test-design → implementation → refactor → review → integrate-suite → verify-final-candidate → pull-request → publish → succeeded`

A coding stage advances only after both a valid report and its stage-specific trusted gates succeed. Refactoring and review may change code; rerun required checks against their resulting snapshots. Pull-request drafting starts only after exact-tree verification and runs against a disposable analysis clone whose changes cannot reach the publication workspace.

### State ownership

The factory is the sole writer of active run state. Record stage, attempt number, completed stages, workspace snapshot, acceptance-bundle version, correction-used flag, and terminal reason. Artifacts are evidence, not a restart log. Starting a new invocation creates a new run; no implicit resume.

Every attempt receives the ticket, standards, current code, diff from base, acceptance rationale, bounded prior-stage reports, and relevant failure evidence. It receives no previous transcript as conversational history. Retain transcripts for diagnostics outside the writable agent workspace.

Terminate the previous attempt and confirm its process/container has stopped before snapshotting or starting recovery. Preserve usable partial code changes, including uncommitted changes; do not silently reset a failed implementation.

### Finite budgets

- Each of the four coding stages has at most two attempts: initial plus one fresh recovery.
- Pull-request drafting has at most two fresh attempts. Each attempt receives a new disposable analysis clone of the same verified tree; malformed, blocked, failed, or timed-out drafts consume its budget.
- Preflight/configuration failures stop immediately; agents do not repair unrelated environment setup.
- Allow at most one acceptance-test correction invocation per run, in a fresh test-design session. It is distinct from recovery of the initial test-design stage.
- A defect reported on a downstream coding stage's first attempt may trigger correction, then the reporting stage's second attempt. A defect on its second attempt stops the run: there is no third execution.
- A rejected correction or another defect report stops the run. No recovery of the correction agent itself.
- Absolute ceiling: eight coding-stage attempts, two pull-request attempts, and one correction invocation, with a finite timeout on each. Cancellation is terminal, not automatically retried.

This resolves the brief's proposed correction-budget rule explicitly. Corrections do not reset counters.

A correction is checked against the original ticket and original baseline, not only the partially implemented code. If accepted, publish a new authoritative suite version and rerun the current tree's relevant checks. Prior acceptance evidence tied to the old suite cannot establish final success; the final reviewer must inspect the correction and current results.

## 6. Protected tests and trustworthy gates

### Test-design protocol

The test-design agent writes only a candidate acceptance suite and rationale. Run it with production code read-only; do not allow it to implement the feature. Candidate files are not authoritative until the verifier validates and promotes them.

For the sample API, prefer black-box HTTP acceptance tests that compile independently of the application. A missing endpoint can produce a meaningful behavioral failure without inventing internal types or relying on an uncompilable test project.

Validation includes:

- Every ticket criterion is mapped to a test or an explicit review-only check.
- The test project builds and discovers the expected tests; skipped or zero-test runs cannot count as passing.
- Feature/bug failures match the intended missing behavior. Arbitrary nonzero exit codes do not satisfy the red phase.
- Refactor acceptance tests pass against the original baseline.
- Production files were not changed by test design.

Semantic adequacy cannot be proven by exit codes. Preserve the test-design rationale, require final independent review, and use the proof harness's independent evaluator to catch solutions that satisfy weak generated tests but not the ticket.

### Trust boundary

Keep authoritative suites, gate definitions, run manifests, and publication credentials outside all agent-writable paths. Downstream agents see acceptance tests through read-only mounts. Only an orchestrator-owned promotion operation may replace a suite after authorized correction.

Run trusted acceptance tests in a separate verifier container/process from the agent and application-under-test. The application build and runtime are untrusted too: repository MSBuild targets can execute arbitrary code. They must not share writable result locations, host credentials, or the protected test runner's authority. For the sample, use a trusted external HTTP test runner talking to an isolated application container.

The agent can run local checks for TDD, but agent-generated output alone is not trusted gate evidence. Have the orchestrator capture check process exits and results from its own verifier. Do not let a repository script select a different test suite or fabricate a successful acceptance report.

Do not expose the host Docker socket, privileged mode, or publication credentials inside agent containers. The host orchestrator/backend may control Docker; the agent cannot. Restrict mounts to the dedicated workspace and explicit read-only inputs. vLLM must be reachable from the sandbox without falling back to a hosted provider.

Read-only suites prevent modification, not overfitting. Tests remain visible by design; independent review and fixture evaluation address adequacy, not a claim of adversarial-proof correctness.

## 7. Git and final publication

Use a disposable isolated clone for agent work. Avoid a writable worktree whose shared Git metadata gives the agent authority over the source repository's branch references.

The Git workspace module records the source base commit, creates the run branch, and owns export of that branch to the local target repository. Agents may commit within the disposable clone but cannot push to or modify the source repository directly. If the runtime has automatic merge behavior, disable it; inability to disable it is a spike failure.

After review:

1. Stop all coding-agent processes.
2. Integrate the authoritative acceptance suite and its reproducible runner assets into the output tree using the orchestrator-owned operation.
3. Run final checks on that exact tree, with the authoritative external verifier.
4. Create a disposable Git analysis clone with the same publishable-tree identity. Run a fresh pull-request explanation agent there; discard the clone after every attempt.
5. Render the accepted structured explanation plus orchestrator-observed checks to host-owned `artifacts/PR.md`. Never commit it into the candidate tree.
6. Publish the unchanged verified tree as the designated new branch and capture the final commit identity.
7. Verify the source base branch reference is unchanged and emit the success report with the `PR.md` path.

No remote push or merge is required. On failure preserve the isolated diagnostic branch/workspace and identify its location; never label it as the successfully completed output. Publication errors are terminal infrastructure failures, not coding-agent retries.

## 8. Delivery phases

Run focused behavioral tests during each implementation phase and a real smoke scenario at its exit. Tests using deterministic substitute agents establish orchestration semantics; they do not replace real vLLM proof runs.

### Phase 0 — Runtime compatibility and stack decision

Deliver:

- One minimal real sandboxed coding task through the actual vLLM deployment.
- Two independent sessions showing workspace continuity without conversation/session reuse.
- Observed tool calling, standards delivery, structured output extraction, branch control, cancellation, timeout, and read-only mount behavior.
- A runtime decision with exact versions, model ID, quantization, endpoint configuration, and known limits, excluding secrets.

Prefer Sandcastle plus a compatible coding runtime; evaluate OpenHands if the first combination fails requirements. Do not write a custom coding-agent loop to rescue an unsuitable dependency.

Exit: a real .NET edit and command execution succeed; forbidden test writes fail; timeout stops execution; base branch remains unchanged. If required infrastructure/model access is unavailable, record the missing prerequisite rather than infer compatibility.

### Phase 1 — Module boundaries and independent sample fixtures

Deliver:

- Workspace/toolchain configuration, package exports, dependency enforcement, and CLI composition root for the selected stack.
- Factory-owned values and ports with documented ownership/failure semantics.
- Controlled .NET 10 sample with its own instructions, skills, build/test commands, and a runnable API.
- Four tickets and independent baseline fixtures; no completed solutions accessible to agents.

Use capability-oriented sample organization if adopting VSA explicitly. Load the .NET API, C#, and .NET 10 conventions when implementing that package; do not impose sample architecture on the orchestrator.

Exit: sample starts, a real HTTP behavior is observed, baseline checks pass, ticket parser rejects missing acceptance criteria, and dependency enforcement rejects a forbidden import.

### Phase 2 — Workspace, evidence, and trusted verification

Deliver:

- Isolated clone lifecycle, branch collision handling, snapshot identities, and safe local publication.
- Host-owned run manifest and evidence files; ignored run directories and secret redaction.
- Candidate-suite validation/promotion, read-only distribution, verifier/app separation, and trusted command results.

Exit: a real disposable repository survives a failed attempt with changes preserved; source refs remain untouched; an attempted acceptance-suite write is denied; a deliberately failing acceptance test is reported as failed by the trusted runner.

### Phase 3 — End-to-end happy path

Deliver:

- Markdown input and trusted repository profile loading.
- Explicit four-stage coding execution plus isolated pull-request drafting, all with fresh sessions and versioned context bundles.
- Stage-specific prompts, report parsing, criterion gates, TDD evidence, final review with fixes, and structured PR explanation output.
- Final commit publication and human-readable plus machine-readable reports, including host-owned `PR.md`.

Exit: one actual feature ticket completes through vLLM; inspect the resulting diff, `PR.md`, and published branch independently. All four coding-stage identities, the pull-request identity, and final check evidence must be present. No human command approval is required within the run.

### Phase 4 — Bounded failure and correction paths

Deliver:

- Initial/recovery attempt state transitions and terminal stop behavior.
- Authorized one-time test correction, suite version replacement, and invalidated-evidence handling.
- Timeout/cancellation cleanup and preserved partial work.
- Proof-only deterministic fault injection at the attempt boundary; no magic failure strings in production prompts.

Exit scenarios:

- First implementation attempt fails after changing files; a fresh recovery sees those changes and succeeds.
- Both implementation attempts fail; no refactor/review starts and the report is unsuccessful.
- Invalid stage output consumes an attempt and never passes a gate.
- One valid test correction permits recovery without resetting budgets.
- A rejected correction, repeated defect, or defect on an exhausted attempt terminates.
- A timed-out agent cannot continue changing files during recovery.

### Phase 5 — Full proof suite and repeatable operation

Deliver:

- Feature, bug, refactor, recovery-success, and recovery-exhaustion scenario results from clean fixed baselines.
- Independent evaluators kept outside agent-visible/writable inputs. For refactoring, combine behavioral checks with explicit structural review criteria rather than source-text snapshots.
- Documented CLI usage, required tools, model configuration, check commands, evidence locations, timeouts, and failure interpretation.
- Actual runtime and repository conventions reflected in the README without presenting the broader factory as implemented.

Run scenarios sequentially. Record failures as failures; do not silently repeat until a model happens to succeed. A deliberate rerun gets a separate run identity and report. Infrastructure fault injection is deterministic; model success is not guaranteed to be deterministic.

Exit: inspect each successful output branch, independently exercise its behavior, and verify the negative scenario stops with exactly the permitted attempts. The proof suite demonstrates all brief acceptance conditions.

## 9. Fixture design

| Scenario | Baseline arrangement | Independent outcome check |
|---|---|---|
| Medium feature | Stock API without reservation capability | Create, confirm, cancel, invalid transitions, and no over-reservation |
| Bug | Reservation fixture containing reproducible double-restock defect | Repeated cancellation cannot increase available stock beyond the correct amount |
| Refactor | Working reservation fixture with genuinely duplicated transition policy | Existing behavior preserved; agreed duplication removed without bypassing standards |
| Recovery success | Feature fixture plus injected first-attempt execution failure after changes | Fresh attempt identity, preserved changes, passing final behavior |
| Recovery exhausted | Same fixture with failure on both allowed implementation attempts | Terminal failure, exactly two implementation attempts, no later stages |

Build fixtures in temporary Git repositories from committed source plus explicit fixture transformations. Do not depend on the feature ticket succeeding to create the bug/refactor starting points. Keep evaluator code and completed expected solutions out of the agent context.

## 10. Verification and maintenance strategy

- Factory tests cover consumer-visible transitions, recovery ceilings, acceptance verdicts, correction rules, and failure precedence.
- Adapter contract tests cover fresh sessions, cancellation, evidence validity, immutable suites, and branch preservation using actual boundaries where feasible.
- Integration tests use disposable Git repositories and containers for filesystem, process, and publication behavior.
- Proof scenarios exercise real runtime/vLLM behavior and published branches; they are distinct from deterministic policy tests.
- Do not test prompt wording, copies of configuration defaults, forwarding methods, or exact incidental event sequences.
- Keep report schemas additive only when needed; during this POC migrate producers/consumers together rather than add compatibility shims.
- Each module change owns its local tests and docs. Only composition wiring, shared contract changes, and workspace dependencies require cross-module integration.
- Assign one owner to a shared contract change and migrate all callers in the same change. Narrow boundaries reduce conflicts; they do not eliminate conflicts in shared policies or contracts.
- Independent implementation work can proceed after contracts stabilize: execution backend, Git workspace, verifier, and artifact storage. Integrate through the CLI composition root; never duplicate retry rules in adapters.

## 11. Completion checklist

- [ ] Actual vLLM/runtime compatibility is demonstrated and recorded.
- [ ] Modules have directed dependencies and replaceable external contracts.
- [ ] One Markdown ticket runs without human intervention inside isolated execution.
- [ ] Every stage and recovery uses a fresh session and explicit handoff artifacts.
- [ ] Test design produces meaningful tests and rationale before implementation.
- [ ] TDD, refactoring, and review-with-fixes have recorded evidence.
- [ ] Acceptance tests and trusted gate results are outside downstream write authority.
- [ ] Recovery and correction are bounded and exhausted failures are explicit.
- [ ] Final checks correspond to the published commit content.
- [ ] Success publishes only a new solution branch; the base branch is unchanged.
- [ ] Successful output includes host-owned `PR.md` generated from an isolated copy of the verified tree.
- [ ] Feature, bug, refactor, recovery-success, and recovery-exhaustion proof cases are exercised.
- [ ] Operation and replacement boundaries are documented without claiming unimplemented broader-factory capabilities.
