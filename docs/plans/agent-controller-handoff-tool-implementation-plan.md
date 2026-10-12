# Agent-to-controller handoff tool implementation plan

## 1. Human-review summary

### Summary
- Outcome: Every planner, implementation, review, integration, and pull-request-content agent returns its authoritative result through one schema-configured `submit_handoff` MCP tool instead of JSON embedded in assistant XML/prose.
- Scope: Add an isolated generic handoff transport to the agent runtime and sandbox, migrate all five stage contracts and prompts, preserve each feature's schema and completion policy, and remove the obsolete XML/completion-signal parsing path.
- Readiness: Execution-ready.

### Explain like I'm five

For each agent run, the controller gives the sandbox one `submit_handoff` tool whose argument shape matches that stage. The agent performs its work and calls the tool once; the tool validates and stores the typed arguments in a private per-run channel. After the agent exits, the controller validates the same payload again and hands it to the owning feature. Normal assistant prose remains useful in logs but can no longer accidentally masquerade as a completed stage.

### Target flow

```mermaid
sequenceDiagram
    participant C as Controller
    participant A as Agent
    participant T as submit_handoff MCP tool
    participant F as Stage feature

    C->>T: Create isolated run contract and stage schema
    C->>A: Start one agent iteration with submit_handoff available
    A->>A: Work and verify
    A->>T: submit_handoff(stage-shaped arguments)
    alt Arguments invalid
        T-->>A: Exact schema error; no result stored
        A->>T: Corrected submit_handoff call
    else First valid call
        T->>T: Atomically store immutable result
        T-->>A: Accepted; stop without further work
    end
    A-->>C: Process exits
    C->>C: Read, authenticate, and revalidate result
    alt Valid handoff and stage postconditions
        C-->>F: Return typed handoff
    else No handoff
        C-->>F: Incomplete iteration
    else Invalid result or postcondition
        C-->>F: Fail and retain evidence/workspace
    end
```

### Affected code

```text
.
├── package.json / package-lock.json                         — add pinned MCP server and JSON-Schema validation dependencies
├── factory/
│   ├── infrastructure/
│   │   ├── agent-runtime/                                  — generic handoff contract, per-run channel lifecycle, MCP server asset, result validation, and runtime tests
│   │   └── sandbox/                                        — mount the isolated control channel, configure/preflight the MCP server for Pi and oh-my-pi, and update the image
│   └── features/
│       ├── plan-tickets/                                   — planner-owned handoff schema, prompt, consumption, and tests
│       ├── implement-ticket/                               — implementation handoff, three-iteration semantics, prompt, and tests
│       ├── review-ticket/                                  — review handoff, three-iteration semantics, prompt, and tests
│       ├── integrate-tickets/                              — integration handoff with conflict dispositions, prompt, and tests
│       ├── publish-pull-request/                           — read-only title/body handoff, prompt, and tests
│       └── ticket-processing/                              — controlled runner fixtures and bounded workflow coverage for the new result contract
├── README.md                                               — document tool-based stage completion and diagnostics after implementation
├── AGENTS.md                                               — record the implemented handoff, ownership, retry, and sandbox contracts after implementation
└── docs/plans/
    └── agent-controller-handoff-tool-implementation-plan.md — this implementation plan
```

### Assumptions

- “The same handoff tool” means one stable tool name, `submit_handoff`, with a per-invocation description and JSON Schema supplied by the owning stage; it does not mean one permissive union schema or a runtime registry of stage types.
- A successful handoff replaces both the stage XML output block and `<promise>COMPLETE</promise>`/`</plan>` as authoritative completion evidence.
- The tool is available to both configured harnesses through MCP and is used for every current agent stage in one clean cutover.

## 2. Scope and acceptance criteria

**In scope**

- One generic local stdio MCP server that exposes `submit_handoff` from a per-run contract.
- A unique writable control channel per agent run, mounted outside the repository and inaccessible to sibling runs.
- Stage-owned schemas and typed results for planning, implementation, review, integration, and pull-request content.
- Immediate JSON-Schema argument rejection in the tool plus authoritative host-side validation by the owning feature schema.
- First-valid-call-wins behavior, explicit missing/invalid/duplicate handling, credential-safe diagnostics, and tool-call summaries that do not dump handoff payloads.
- Preservation of global agent leases, three single-iteration implementation/review/integration loops, Git postconditions, checkpoint ownership, publication immutability, and retained failed workspaces.
- Direct migration of all controlled `AgentRunner` fixtures and removal of structured assistant-output compatibility paths.

**Out of scope**

- A stage registry, mediator, event bus, distributed state, resumable partial attempts, cross-process coordination, or a generic pipeline context.
- Allowing agents to commit, publish, settle tickets, or bypass existing controller postconditions.
- Parsing assistant prose as a fallback when the tool is omitted.
- General-purpose arbitrary controller RPC from agents; the MCP server accepts only the configured handoff tool.
- Changes to provider publication behavior, ticket grouping policy, checkpoint content, or retry counts beyond replacing structured-output failure handling.

**Acceptance criteria**

- AC1: Every current agent stage receives a tool named `submit_handoff`; its visible argument schema matches only that stage's existing result contract, and the agent runtime contains no ticket, planner, review, integration, or publication schema knowledge.
- AC2: A valid first tool call is stored atomically in an isolated per-run channel, survives until the host consumes it, and becomes the typed `AgentRunResult.handoff`; no XML block, completion signal, or assistant-text parsing participates in success.
- AC3: Invalid arguments return actionable field-level errors to the agent without storing a result; a corrected call in the same agent turn can succeed. A second call after acceptance is rejected and cannot replace the first result.
- AC4: The host checks the invocation nonce/tool identity, bounds the control artifact, reruns the feature-owned validator, rejects known provider credential material where the result can reach commits/logs/provider content, and never logs the raw handoff payload by default.
- AC5: Implementation, review, and integration still permit at most three single-iteration work runs. A run with no accepted handoff is incomplete and may consume the next stage iteration; a valid handoff returns immediately to stage postconditions; malformed assistant prose cannot restart completed work.
- AC6: Planning remains factory-immutable, pull-request content remains HEAD/porcelain-immutable, mutating agents still cannot change HEAD/branch or commit, and all existing checkpoint/publication gates remain authoritative after a handoff.
- AC7: Concurrent agent jobs cannot read, overwrite, or reuse another job's contract or result; temporary control artifacts never enter ticket/factory Git status and are cleaned on success and failure after required diagnostics are recorded.
- AC8: Pi and oh-my-pi preflight both prove that the handoff MCP server is connected and exposes `submit_handoff`; controlled protocol and Docker smoke runs prove valid, invalid, duplicate, and missing-handoff behavior.
- AC9: Prompts instruct agents to call `submit_handoff` exactly once only after stage obligations pass and contain no obsolete XML/JSON wrapper or completion-signal instructions. All old `Output.object`, `StructuredOutputError`, and completion-signal stage paths are removed.
- AC10: Stage logs distinguish handoff acceptance, rejection, omission, and transport failure without exposing full message/body content or credentials; a retry is labeled as another work iteration rather than appearing as an unexplained restart.

## 3. Design decisions

- D1: Use one stable `submit_handoff` MCP tool with a dynamic per-run schema. Reason: one transport works across all stages and harnesses without teaching infrastructure stage names or maintaining a permissive union. Contract: the feature supplies tool description, JSON Schema, and host validator; infrastructure exposes and transports them unchanged.
- D2: Keep schemas feature-owned and derive the MCP-visible JSON Schema from the same Zod contract used for host validation. Reason: this preserves current ownership and avoids separate model-facing and controller-facing definitions drifting. Contract: structural/string bounds must be JSON-Schema-representable so the MCP server can reject them immediately; feature domain checks such as exact planner membership remain host-side after structural validation.
- D3: Use an official MCP SDK stdio server with a pinned JSON-Schema validator rather than hand-writing protocol framing. Reason: both harnesses already consume MCP, while protocol correctness and validation error shape are not useful project-specific code. Contract: dependencies are pinned in the root lockfile and installed at matching versions in the sandbox image; the server has no network listener and exposes no tool except `submit_handoff`.
- D4: Transport the handoff through a unique host-created control directory bind-mounted at a fixed sandbox path, never through the repository. Reason: repository files would contaminate checkpoints and permit cross-stage confusion. Contract: each directory contains a nonce-bearing read-only contract and at most one exclusively published result; sibling containers receive different host paths.
- D5: Make the first valid handoff immutable. Reason: completion must have one unambiguous result even if the model calls the tool repeatedly. Contract: validate before publication, atomically publish with exclusive first-write semantics, reject later calls, and consume only after the agent process exits.
- D6: Treat the accepted tool result as completion evidence and assistant text as diagnostics only. Reason: this removes dependence on XML, JSON escaping, stop strings, and prose shape. Contract: no prose fallback; missing handoff is an incomplete run, and a successful handoff is still subject to every existing Git/workspace/provider postcondition.
- D7: Preserve stage-owned retry semantics. Reason: a missing handoff can mean unfinished work, whereas invalid tool arguments can be corrected in the same turn. Contract: implementation/review/integration keep their three outer work iterations and catch only a dedicated missing-handoff outcome; planner and pull-request content retain their existing single-run failure behavior; infrastructure/MCP failures remain fatal.
- D8: Return field-level validation errors from the MCP tool but keep secrets out of diagnostics. Reason: the model needs enough information to repair a call without the controller replaying rejected payloads. Contract: errors identify JSON paths, constraints, and duplicate/missing state; they do not echo complete values. Host credential checks remain authoritative because provider secrets are never passed into the sandbox validator.
- D9: Keep one invocation lease around the complete agent run, including any same-turn handoff corrections. Reason: tool validation is part of that agent job and must not bypass `--max-parallel`. Contract: no background handoff worker or independently leased correction job is introduced.
- D10: Perform a clean cutover. Reason: dual XML/tool protocols would create precedence ambiguity and preserve the exact failure mode being removed. Contract: migrate every caller/fixture/prompt, rename the result field to `handoff`, remove `output`, completion-signal checks, structured-output imports, and obsolete tests without aliases or fallback parsing.

## 4. Implementation steps

### Step 1: Define the generic handoff contract and stage-owned schema adapter

- **Code area:** `factory/infrastructure/agent-runtime/`; the five stage schema modules under `factory/features/`.
- **Change:** Add a generic `AgentHandoffDefinition<T>` carrying the stable tool name, stage-specific description, JSON Schema, and authoritative validator. Add a small feature-facing constructor that derives JSON Schema from a Zod schema while retaining the Zod parse result as `T`. Make current constraints representable in JSON Schema where needed (required fields, strict objects, lengths, arrays, control-character/trailer patterns) without moving schemas into infrastructure. Preserve host-only domain validation such as exact supplied planner groups and complete integration conflict dispositions. Define dedicated errors for missing handoff, rejected host validation, duplicate/stale envelopes, and transport failure; do not classify infrastructure errors as incomplete work.
- **Depends on:** None.
- **Verification:** Colocated tests construct each stage definition, inspect that `submit_handoff` exposes only that stage's fields/bounds, and prove the host validator accepts existing valid results and rejects blank/oversized/extra/forged values (AC1, AC3, AC4).

### Step 2: Implement the isolated MCP handoff server and protocol tests

- **Code area:** `factory/infrastructure/agent-runtime/` (new server asset and tests), `package.json`, `package-lock.json`.
- **Change:** Add the pinned MCP SDK and JSON-Schema validator. Implement a generic stdio server that fails startup on a missing/malformed contract, returns the dynamic schema from `tools/list`, handles only `submit_handoff`, validates arguments without echoing rejected values, and atomically publishes a nonce-bearing result only after validation. Use an exclusive atomic publication sequence so concurrent/duplicate calls cannot replace the first accepted result. Return a terminal success message instructing the agent not to run more tools or mutate files. Bound contract/result byte sizes and file permissions. The server must not import features, inspect tickets, execute Git, access provider credentials, or expose network endpoints.
- **Depends on:** Step 1.
- **Verification:** Spawn the real stdio server in tests and exercise MCP initialize/list/call: valid stage payload, missing field, extra field, over-limit field, malformed contract, first valid call, duplicate call, nonce mismatch, partial/crashed publication, and payload-size bounds. Assert one immutable result and no raw rejected payload in stderr/tool errors (AC2, AC3, AC4).

### Step 3: Add per-run control-channel lifecycle and sandbox wiring

- **Code area:** `factory/infrastructure/agent-runtime/agent-runtime.ts`, proposed handoff channel helper(s), `factory/infrastructure/sandbox/sandbox.ts`, `factory/infrastructure/sandbox/Dockerfile`, `factory/infrastructure/sandbox/check-mcp.mjs`, `factory/infrastructure/agent-runtime/create-agent.ts`, `stream-events.ts`, and colocated tests.
- **Change:** For every `AgentRunRequest`, create a mode-restricted temporary control directory, generate a random invocation nonce, write the read-only contract, and pass a writable bind mount to that run's Docker sandbox. Register the MCP server in both Pi and oh-my-pi configuration with direct exposure and update preflight to verify the same `submit_handoff` tool for each selected harness. Build/install the pinned server dependencies in the image while mounting or copying the repository-owned server asset from a repository-root-resolved path. After Sandcastle exits, read exactly one bounded envelope, verify nonce/tool identity, revalidate with the request's feature-owned validator, and return it as `AgentRunResult.handoff`. Clean the temporary directory in structured cleanup on success and failure after recording safe diagnostics. Special-case stream summaries so `submit_handoff` logs only its name/status, never arguments. Preserve session capture, model/skill mounts, `.env` masking, host networking, and the invocation lease.
- **Depends on:** Step 2.
- **Verification:** Runtime tests use temporary control directories and controlled process output to prove success, omission, invalid envelope, stale nonce, duplicate result, cleanup, log redaction, and isolation between simultaneous runs. Rebuild the real image; run Pi and oh-my-pi MCP discovery/preflight and confirm the dynamic tool is connected/directly exposed with the configured schema while models, skills, Roslyn, Microsoft Learn, and credential masking still resolve correctly (AC2, AC4, AC7, AC8, AC10).

### Step 4: Cut planning over to `submit_handoff`

- **Code area:** `factory/features/plan-tickets/group-plan-schema.ts`, `group-plan-prompt.md`, `plan-tickets.ts`, `group-plan.test.ts`.
- **Change:** Supply the planner schema through the generic handoff definition, instruct the planner to call `submit_handoff({ groups })`, consume `result.handoff`, and remove `<plan>`, `</plan>`, `Output.object`, and completion-signal handling. Keep at-most-one group, exact group/member/order/title validation, and factory immutability unchanged. A missing handoff is a planning failure, not an empty selection; only an accepted `{ groups: [] }` means select nothing.
- **Depends on:** Step 3.
- **Verification:** Planner tests prove exact valid selection, accepted empty selection, unknown/changed/duplicate/excess selection rejection, missing handoff failure, and factory mutation rejection. No test accepts equivalent prose or XML output (AC1, AC2, AC6, AC9).

### Step 5: Cut implementation, review, and integration over while preserving work retries

- **Code area:** `factory/features/implement-ticket/`, `factory/features/review-ticket/`, `factory/features/integrate-tickets/`, including prompts, schemas, stage runners, and tests.
- **Change:** Give each stage the same `submit_handoff` tool with its own schema: `{ message }` for implementation/review and `{ message, conflicts }` for integration. Replace `result.output` with `result.handoff`; remove XML blocks, `<promise>COMPLETE</promise>`, Sandcastle `Output`/`StructuredOutputError`, and format-retry branches. Prompts must call the tool only after all work and verification obligations pass and must emit no success handoff on blockers. Keep three single-iteration outer loops: only `MissingAgentHandoffError` consumes another work iteration in the same uncommitted workspace; schema/transport/infrastructure errors and accepted-handoff postcondition failures do not trigger another implementation/review/integration run. Preserve clean entry requirements, expected branch/HEAD, no-agent-commit rule, pending merge handling, conflict dispositions, marker checks, and runner-owned checkpoints.
- **Depends on:** Steps 1 and 3.
- **Verification:** Stage tests prove valid typed handoffs, one accepted handoff after earlier missing-handoff iterations, failure after three omissions, immediate failure without another work run for invalid/duplicate/transport outcomes, unchanged branch/HEAD enforcement, retained dirty work, and complete integration conflict dispositions. Add the regression from the observed incident: assistant prose that claims completion without a tool result is incomplete and cannot be committed; a valid handoff cannot cause a fresh implementation run (AC3, AC5, AC6, AC9, AC10).

### Step 6: Cut pull-request content over without weakening publication gates

- **Code area:** `factory/features/publish-pull-request/pull-request-schema.ts`, `pull-request-prompt.md`, `publish-pull-request.ts`, `publish-pull-request.test.ts`.
- **Change:** Expose `{ title, body }` through `submit_handoff`, consume the typed handoff, and remove the `<pull-request>` block/completion signal. Preserve title/body limits, the bounded GitHub squash note, content-stage HEAD and porcelain immutability, trace-before-publication ordering, commit-count/change-set/final-SHA gates, safe push, provider calls, and publication failure substages. A missing handoff remains `pull-request content` failure before push/provider HTTP.
- **Depends on:** Steps 1 and 3.
- **Verification:** Existing publication behavior tests are migrated to handoffs and continue proving unchanged content, body bounds, mutation rejection, no-change/no-commit gates, push/provider ordering, GitHub note bounds, Azure strategy validation, and credential-safe failures. Add missing/invalid handoff cases that prove no remote operation occurs (AC1, AC4, AC6, AC9).

### Step 7: Migrate workflow fixtures and prove concurrency/isolation end to end

- **Code area:** `factory/features/ticket-processing/` tests and any remaining `AgentRunner` fixtures across `factory/`.
- **Change:** Migrate controlled runners to inspect the request's handoff definition and return `handoff` rather than `output`/`completionSignal`. Remove compatibility casts and obsolete structured-output test fixtures. Extend the bounded dependency-cycle scenario so planner, implementation, review, integration when applicable, and pull-request content all use stage-shaped handoffs under the existing global lease pool. Run at least two concurrent agent jobs with distinct control channels and assert no contract/result crossover, unchanged scheduling bounds, one checkpoint per successful mutating stage, and unchanged publication/settlement ownership.
- **Depends on:** Steps 4–6.
- **Verification:** Focused ticket-processing tests observe terminal files, checkpoint count/SHA/trailers, log references, pushed SHA, PR request/result, and failure settlement for valid, missing, and isolated concurrent handoffs. Architecture checks continue rejecting feature imports from infrastructure and deep cross-feature imports (AC5, AC6, AC7, AC9).

### Step 8: Update operational documentation and remove obsolete protocol language

- **Code area:** `README.md`, `AGENTS.md`; current prompts/comments/tests across affected folders.
- **Change:** After implementation verification, document `submit_handoff` as the authoritative stage result, feature-owned dynamic schemas, missing-handoff retry behavior, first-valid-call immutability, safe log events, sandbox control-channel isolation, and Pi/oh-my-pi preflight. Remove operational claims and instructions for XML result tags, completion signals, Sandcastle `Output.object`, and structured-output format retries. Keep historical plans historical, including their descriptions of prior implemented behavior.
- **Depends on:** Steps 3–7.
- **Verification:** Search affected operational source/docs for obsolete `<implementation>`, `<review>`, `<integration>`, `<plan>`, `<pull-request>`, `<promise>COMPLETE</promise>`, `Output.object`, and `StructuredOutputError` uses; only intentional historical-plan text may remain. Review README and AGENTS against the implemented runtime and prompts (AC9, AC10).

## 5. End-to-end verification

- Build the updated sandbox image, create a per-run implementation contract, and exercise the real MCP protocol directly in Docker: inspect `submit_handoff`, send an oversized/extra-field payload and observe a safe validation error with no result, send a valid payload and observe one immutable result, then send a duplicate and observe rejection. Repeat discovery and valid submission with both Pi and oh-my-pi configurations (AC2, AC3, AC7, AC8).
- Run a bounded factory iteration with real Markdown tickets, temporary Git repositories/bare remote, real logging, controlled agent processes that call the actual MCP tool, and the provider HTTP seam. Observe planner selection, implementation and review checkpoints, optional integration conflict dispositions, read-only PR content, pushed final SHA, draft PR request/result, terminal ticket movement, and no handoff files in either repository. Repeat with an implementation process that emits convincing success prose but omits the tool; expect another work iteration and no checkpoint from the prose-only run. Repeat with a valid handoff followed by malformed assistant prose; expect one checkpoint and no restarted implementation (AC1, AC5, AC6, AC9, AC10).
- Run the same bounded scenario with two ready tickets and `--max-parallel 2`; block both agents until their contracts exist, submit distinct handoffs, and verify each result reaches only its own ticket while peak jobs remain bounded by the existing lease pool (AC7).
- Run focused feature/runtime tests, then `npm run verify`. Run the actual available CLI smoke `npm run factory -- --help`; also run the repository-prescribed `npm run sandcastle -- --help`, recording the existing missing-script mismatch separately unless that script is independently corrected. Expected functional smoke behavior is help-first exit without `.env`, credentials, logging, MCP startup, or Docker preflight (AC6).
- With configured model access, run one disposable no-change handoff through each live harness and inspect the actual stage log/tool result. If external model access is unavailable, report that live prerequisite explicitly; do not substitute controlled MCP protocol coverage as proof of model behavior (AC8, AC10).

## 6. Risks and open decisions

- **Risks:** MCP clients may differ in how they render dynamic schemas and validation errors; mitigate with the same direct server contract plus real Pi and oh-my-pi discovery/call smoke. Zod-to-JSON-Schema conversion may omit custom refinements; keep structural constraints representable and always rerun the authoritative feature validator on the host. A model can still omit or prematurely call the tool; omission remains bounded incomplete work, while existing Git/workspace postconditions guard the final state after an accepted call. Writable bind mounts can leak across runs if reused; unique directories, nonces, restrictive permissions, exclusive publication, and cleanup prevent reuse. Image/source dependency versions can drift; pin and preflight the server/version alongside existing harness assets. Tool payloads may contain sensitive prose; never log raw arguments, keep control files ephemeral, and retain existing credential rejection before commit/publication.
- **Open decisions:** None.
