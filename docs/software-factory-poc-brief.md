# Software Factory POC — Implementation Brief

## Goal

Build a manually invoked, hands-off coding pipeline that takes a Markdown ticket with acceptance criteria and produces a Git branch containing a tested, reviewed solution.

The POC tests **core orchestration**: fresh-context stages, artifact handoffs, quality gates, protected acceptance tests, and bounded recovery. It does not attempt general-purpose repository support or production-scale operation.

## Scope

| Area | Decision |
|---|---|
| Input | One Markdown ticket with acceptance criteria |
| Target | One controlled C#/.NET 10 sample repository |
| Invocation | Terminal command; agents execute in containers/sandboxes |
| Concurrency | One ticket per invocation |
| Inference | ChatGPT subscription through OpenCode, `openai/gpt-6-luna` |
| Standards | Supplied agent skills and repository `AGENTS.md` |
| Agent context | Fresh session for every stage and recovery attempt |
| Success output | Committed Git branch, host-owned `PR.md`, and evidence report; no automatic merge |
| Failure output | Explicit failure report and preserved diagnostic artifacts |
| Recovery | One fresh recovery attempt per failed stage |
| Restart behavior | No recovery after orchestrator crash or restart |
| Orchestrator stack | Selected after runtime compatibility spike |

Initially use the same configured model across stages. Stage responsibilities and fresh contexts provide separation without adding model-routing variables.

## 1. Runtime compatibility spike

**Purpose:** prove the agent runtime can execute the required workflow against the authenticated GPT-6 Luna subscription before building the pipeline.

Sandcastle and OpenHands remain candidates. [Sandcastle](https://github.com/mattpocock/sandcastle) is an orchestration/sandbox library that launches an underlying agent; choosing it does not by itself settle the coding-agent runtime.

### Spike procedure

Evaluate one candidate end to end first. Start with Sandcastle plus OpenCode's built-in OpenAI subscription provider. Evaluate OpenHands if that combination cannot meet the requirements without disproportionate custom work.

Use the exact `openai/gpt-6-luna` model identifier and record the OpenCode/container versions; the configured name alone does not prove compatible tool calling.

| Capability | Required evidence |
|---|---|
| Subscription inference | Agent completes a task through the authenticated OpenAI provider using GPT-6 Luna |
| Coding tools | Agent reads files, edits code, and runs a .NET command inside the sandbox |
| Fresh sessions | A second invocation receives explicit handoff artifacts but no previous conversation history |
| Workspace continuity | Second invocation sees code changes from the first |
| Standards delivery | Repository instructions and supplied skills are available to each fresh session |
| Programmatic control | Orchestrator can start an agent, detect completion/failure, and terminate an overlong attempt |
| Branch control | Changes remain on the designated output branch; the base branch is unchanged |
| Test protection | Downstream execution cannot alter authoritative acceptance tests |
| Evidence capture | Command results, agent outcomes, and changed commits are available for reporting |

**Spike deliverable:** a runnable demonstration, observed limitations, and a runtime/stack decision. Do not build a broad multi-runtime abstraction for this POC.

## 2. Pipeline

### Preflight

Before starting an agent:

- Read the ticket and require explicit acceptance criteria.
- Prepare an isolated workspace and dedicated branch from a known base commit.
- Load repository instructions and configured skills.
- Verify the sample repository’s baseline build and tests.
- Record the ticket, base commit, model configuration, and check commands.

A broken baseline or invalid setup fails preflight; it is not handed to an implementation agent to repair incidentally.

### Stage responsibilities

| Stage | Responsibility | Output and gate |
|---|---|---|
| **Test design** | Translate acceptance criteria into executable behavioral tests before implementing the solution | Tests, criterion-to-test mapping, rationale, and observed baseline results |
| **Implementation** | Solve the ticket using TDD; add implementation-level tests as needed | Working code, TDD evidence, green checks, and an explicit acceptance-criteria verdict |
| **Refactor** | Enforce supplied standards and improve code quality without changing required behavior | Refactored code, changes explained, green checks, and an updated verdict |
| **Code review** | Inspect the complete diff, identify issues, and fix them | Review findings and resolutions, green checks, and final acceptance-criteria verdict |
| **Pull-request draft** | Explain the complete verified change from an isolated analysis copy without modifying the publication workspace | Concise title, summary, ELI5 explanation, execution-order play-by-play, and orchestrator-rendered trusted verification |

#### Test-design gate

For a feature or bug fix, acceptance tests must fail for the intended missing behavior—not because of invalid setup or arbitrary assumptions about private implementation details.

For a behavior-preserving refactor, acceptance tests should pass before implementation and remain green afterward.

Some changes may require a new public contract. In that case, test design must distinguish an intentionally absent contract from an accidentally broken test harness.

The test-design agent does not implement production behavior to make its tests pass.

#### Downstream gates

The orchestrator runs the configured checks itself rather than relying solely on an agent’s claim that they passed.

Stage success requires:

- Required automated checks pass.
- Authoritative acceptance tests remain protected and unchanged.
- The agent supplies the required stage report.
- The acceptance-criteria verdict identifies any unmet or unverifiable criterion.

The final reviewer assesses the whole branch against the ticket, not merely whether earlier stages completed.

## 3. Fresh-context handoffs

Fresh context means **no inherited conversation**, not starting without evidence.

Each agent receives:

- Original ticket and acceptance criteria.
- Current workspace and diff from the base commit.
- Repository instructions and relevant supplied skills.
- Acceptance-test mapping and rationale.
- Concise prior-stage reports.
- Relevant command output and failure evidence.

Keep these as inspectable run artifacts. Do not introduce a conversational memory service.

A small stage-result contract should distinguish:

- Completed.
- Blocked by unmet criteria or failed checks.
- Suspected acceptance-test defect.

Each result identifies supporting evidence, remaining issues, and relevant commits. A runtime exit code alone is insufficient to establish task success.

## 4. Acceptance-test protection

After test design, acceptance tests become read-only to implementation, refactoring, and review agents.

**Proposed enforcement:**

- Maintain the authoritative test suite outside downstream agents’ writable workspace.
- Expose it read-only where agents need to inspect or run it.
- Have orchestrator-controlled gates execute the authoritative suite.
- Protect the associated runner configuration, not only the test source files.
- Include the accepted test suite in the final branch through an orchestrator-owned operation.

A hash check can detect tampering, but is not a substitute for preventing writes to the authoritative copy.

### Defective-test correction

If a downstream agent reports a defective acceptance test:

1. Suspend that stage.
2. Start a fresh test-design recovery agent with the ticket, disputed test, and failure evidence.
3. Allow one correction attempt, limited to restoring fidelity to the acceptance criteria.
4. Validate the corrected suite before continuing.
5. Stop if the defect remains unresolved.

Corrections must be recorded; tests cannot be quietly weakened to accommodate an implementation.

**Proposed recovery-budget rule:** test correction does not create extra implementation attempts. Restarting downstream work uses that stage’s remaining recovery allowance. This keeps the workflow finite.

## 5. Failure and recovery

A failed stage receives one recovery attempt using a new agent session with the same stage responsibility.

The recovery agent receives the current code, ticket, standards, and concrete failure evidence—not the previous agent’s conversation.

Recovery applies to situations such as:

- Failed automated checks.
- Unmet acceptance criteria.
- Agent execution failure.
- Missing or unusable stage output.
- An attempt exceeding its configured time limit.

If recovery fails:

- Stop the pipeline.
- Mark the run unsuccessful.
- Preserve the working branch and diagnostic artifacts.
- Report the failed stage, attempts, and remaining issues.
- Do not present the branch as a completed solution.

No recursive recovery or hidden unbounded agent relaunches. Configure a finite per-attempt timeout; choose its value during the spike based on observed local-model execution.

## 6. Sample repository and proof tickets

**Proposed sample:** a small .NET 10 inventory-reservation API. It provides observable business behavior without requiring UI work or external services.

Use repository-local architecture and standards, with explicit VSA instructions if adopted for the sample. The factory must consume those instructions rather than hard-code that architecture.

Each proof case starts from a fixed baseline so results do not depend on previous tickets.

| Case | Proposed ticket | Success evidence |
|---|---|---|
| **Medium feature** | Add stock reservations with creation, confirmation, cancellation, and prevention of over-reservation | Observable state transitions, invalid-transition handling, and acceptance tests covering stock invariants |
| **Bug report** | Fix cancellation incorrectly returning reserved stock more than once | Reproduction fails before the fix; regression passes afterward without breaking reservation behavior |
| **Refactor** | Consolidate duplicated reservation-transition rules without changing public behavior | Behavioral tests pass before and after; reviewer verifies the requested structural change and standards |
| **Recovery** | Inject a deterministic failure after the implementation attempt has changed files | Orchestrator detects failure, launches exactly one fresh recovery agent, preserves workspace continuity, and proceeds only after gates pass |

For the recovery case, also run a variant where the recovery attempt fails. This verifies bounded stopping and failure reporting, not only the successful recovery path.

The feature, bug, and refactor fixtures must be prepared so each ticket has a genuine, independently verifiable task.

## 7. Run evidence

Each run produces:

- Ticket and base-commit identity.
- Output branch and final commit, if produced.
- Runtime and model configuration, excluding secrets.
- Stage and attempt outcomes.
- Acceptance-criteria mapping and verdicts.
- Test/check commands, exit codes, and relevant output.
- Review findings and fixes.
- Recovery and authorized test-correction records.
- Pull-request draft path and isolated drafting-attempt outcomes.
- Final success or failure status.

Artifacts support inspection; they are **not** a promise of crash-resumable execution.

## 8. Implementation sequence

1. **Prove runtime compatibility.** Select the runtime and orchestrator language from observed results.
2. **Prepare the sample repository.** Establish baseline checks, skills, instructions, and independent ticket fixtures.
3. **Implement the sequential pipeline.** Add fresh-session handoffs, branch handling, stage reports, protected tests, and orchestrator-run gates.
4. **Implement bounded recovery.** Include test-defect correction and deterministic failure injection.
5. **Run the proof suite.** Inspect resulting branches and reports against ticket criteria.

## Definition of done

The POC is complete when:

- One manual invocation runs one ticket without human intervention.
- Every stage and recovery attempt uses fresh agent context.
- Agents execute autonomously inside the sandbox using the configured OpenAI subscription and GPT-6 Luna.
- Acceptance tests are enforced independently of downstream agents.
- The feature, bug, and refactor cases produce committed branches satisfying their criteria and checks.
- Successful runs produce a host-owned `PR.md` that describes the verified tree without adding the file to the solution branch.
- Injected stage failure demonstrates successful recovery.
- Injected recovery failure demonstrates bounded stopping with an accurate failure report.
- No run modifies or merges into the base branch.

**First implementation action:** run the compatibility spike against authenticated GPT-6 Luna. That is the remaining dependency with the greatest influence on the design.
