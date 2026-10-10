# Implementation Plan: Main-loop runner with ticket-orchestrator

## Outcome

`factory/main.ts` becomes a daemon main loop (parse invocation + env config, then `while (stayAlive)`: get tickets from a scanned directory, sleep 10 seconds when none are pending, call `solveTickets`, log the iteration outcome), and the entire per-iteration ticket loop moves into `factory/orchestration/ticket-orchestrator.ts`.

Observable result: `npm run sandcastle -- --repo <path> --tickets-dir <dir>` starts a long-running process that polls `<dir>` for `*.md` tickets, sleeps 10 seconds when nothing is pending, and runs the plan/implement/review/merge stages for pending tickets inside `solveTickets`. `npm run typecheck` passes.

## Acceptance criteria

- `factory/main.ts` contains no plan, implement, review, merge, sandbox, or git-merge-verification logic; it contains only setup (arg parsing, repo/dir validation, sandbox preflight, initial clean-worktree check) and the `while (stayAlive)` loop with ticket discovery, the 0-ticket sleep branch, the `solveTickets` call, and the iteration-outcome log.
- `factory/orchestration/ticket-orchestrator.ts` exports `solveTickets` and contains the full ticket loop body: planner run, planner read-only checks, `validatePlan`, concurrent implement+review per ticket, merge agent, merge verification, and post-merge clean-worktree check.
- Tickets are discovered per iteration by scanning a ticket directory for `*.md` files; already-completed ticket IDs are never re-solved.
- When zero tickets are pending, the process logs the sleep, waits 10 seconds, and continues the loop; the process never exits on its own (daemon).
- The `--ticket` flag no longer exists; `--tickets-dir` is required.
- `npm run typecheck` exits 0.

## Required skills

- `coding-best-practices` — load before editing any TypeScript; governs the module split, import hygiene, and removal of dead imports.

The executor may load an additional skill only when new repository evidence makes it applicable; do not use skill loading to restart research.

## Repository findings

- `factory/main.ts:16-119` — `MAX_ITERATIONS = 10` and the `for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++)` loop body (lines 34-112) is the ticket loop to move; lines 114-118 throw when tickets remain, and line 118 logs completion.
- `factory/main.ts:18-32` — setup that stays in `main.ts`: `parseArgs`, `resolve(options.repo)`, `requireDirectory(repo, "Target repository")`, `runGit(repo, ["rev-parse", "--git-dir"], "validating --repo")`, `preflightSandbox(options.agentHarness)`, initial clean-worktree check (lines 26-29), and the `completed`/`allTickets` state containers.
- `factory/main.ts:39-46` — planner stage: `runPlanAgent(repo, options.agentHarness, iteration, pending, [...completed])`, then throws if `planResult.commits.length > 0` ("Planner modified the target repository; planning must be read-only.") and if `git status --porcelain` is non-empty ("Planner left uncommitted changes in the target repository.").
- `factory/main.ts:47-50` — `validatePlan(planResult.output.tickets, allTickets, completed)`; throws `Planner selected no work while ${pending.length} supplied ticket(s) remain.` when the selection is empty.
- `factory/main.ts:56-94` — per-ticket work: `await using sandbox = await createSandbox({ cwd: repo, sandbox: sandboxProvider(options.agentHarness), branch: ticket.branch })`, `runImplementationAgent` (throws when `commits.length === 0`), `runReviewAgent`, `requireCleanSandbox(sandbox, "Review for ticket ${ticket.id}")`, wrapped in `Promise.allSettled`; failures are collected into one `Implementation/review failed:\n- ...` error (lines 83-90).
- `factory/main.ts:96-111` — merge stage: `runMergeAgent(repo, options.agentHarness, iteration, implemented)`, then `runGit(repo, ["merge-base", "--is-ancestor", ticket.branch, "HEAD"], "verifying merge of ${ticket.branch}")` per ticket, then a clean-worktree check ("Merge stage left uncommitted changes in the target repository."), then `completed.add(ticket.id)`.
- `factory/orchestration/ticket-orchestrator.ts:1-7` — existing stub with empty `solveTickets()` and `solveTicket()`; no imports, no exports, no callers. It is the designated target file.
- `factory/tickets/tickets.ts:31` — `loadTickets(paths: readonly string[]): Promise<Ticket[]>` resolves each path, rejects duplicate paths, non-`.md`, empty content, and duplicate content hashes; ticket `id` is the first 16 hex chars of the SHA-256 of the content, `branch` is `sandcastle/ticket-${id}`. It throws on duplicate paths, so per-iteration discovery must pass a de-duplicated, `.md`-only path list.
- `factory/tickets/tickets.ts:11-17` — `Ticket` shape: `id`, `title`, `path`, `content`, `branch` (all `string`), `Readonly`.
- `factory/tickets/tickets.ts:98,103-129` — `planSchema` caps selections at `MAX_PARALLEL = 1`; `validatePlan(entries, available: ReadonlyMap<string, Ticket>, completed: ReadonlySet<string>)` returns `PlannedTicket[]` and throws for completed, unknown, duplicated, title- or branch-mutated selections.
- `factory/harness/harness-agents.ts:127-220` — exact stage signatures to call from the orchestrator: `runPlanAgent(repo, harness, iteration, pending, completed: readonly string[])`, `runImplementationAgent(sandbox, ticket, harness)`, `runReviewAgent(sandbox, ticket, harness)`, `runMergeAgent(repo, harness, iteration, implemented)`.
- `factory/sandbox/sandbox.ts:6,17,42` — `AgentHarness` type, `sandboxProvider(harness)`, `requireCleanSandbox(sandbox, stage)`.
- `factory/shared/git.ts:11` — `runGit(repo, args, operation)` returns stdout and throws naming the operation.
- `factory/shared/paths.ts:18` — `requireDirectory(path, label)` throws when missing or not a directory; reuse for the ticket directory.
- `factory/cli/cli.ts:7,26-67` — `RunOptions = Readonly<{ repo: string; ticketPaths: string[]; agentHarness: AgentHarness }>`; `parseArgs` accepts `--repo`, `--ticket` (repeatable), `--agent-harness` (`pi` default, `pi|oh-my-pi`), `--help/-h` returns `undefined`; throws for unknown flags, missing values, repeated `--repo`/`--agent-harness`, missing `--repo`, and zero `--ticket` values. Help text (lines 10-22) documents `--ticket` and "up to ten planning iterations".
- `package.json:10-14` — scripts: `sandcastle` = `tsx factory/main.ts`, `typecheck` = `tsc --noEmit`. No test script and no unit tests exist in the repository.
- `tsconfig.json:6-14` — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `include: factory/**/*.ts`; `npm run typecheck` covers every file in this plan.
- `proof/harness/scenario.ts:6`, `proof/scenarios/*.json` — the `ticket` field is required by `proofScenarioSchema` and is not consumed by `proof/harness/materialize-fixture.ts` or `proof/harness/evaluate.ts`; the CLI flag change does not touch proof code.
- `README.md:5,34,38,56` — documents `--ticket`, the repeat-`--ticket` instruction, "ten planning iterations", and the scenario command pattern that passes ticket file paths.

## Assumptions

- `--ticket` is replaced by `--tickets-dir` (single ticket source; the chosen directory scan makes `--ticket` a second source with no discovery benefit). Clean cutover: no compatibility alias, no coexistence.
- `stayAlive` is a literal `const stayAlive = true`; `MAX_ITERATIONS` and the post-loop "uncompleted tickets" throw are deleted. The process is a daemon terminated only by a signal; no signal handling, graceful shutdown, or exit code is added.
- The iteration counter increments on every loop pass, including sleep passes, and is passed to `runPlanAgent`/`runMergeAgent` for log-file naming.
- Sleep is a new `factory/shared/sleep.ts` helper; the 10-second constant lives in `main.ts` as `TICKET_POLL_MS = 10_000`.
- Ticket discovery ignores non-`.md` entries (case-insensitive suffix check, matching `loadTickets`), sorts paths for deterministic ordering, and merges discovered tickets into the accumulated `allTickets` map by `id`, keeping the first occurrence.
- A `readdir` failure on the ticket directory mid-loop (directory deleted) is fatal: the promise rejects and the process exits with the error, consistent with the existing fail-fast style. No retry, no catch.
- Ticket files that are empty, non-`.md`, duplicate-path, or duplicate-content throw through `loadTickets` exactly as today; the daemon exits on those errors.
- Existing console log strings for planner, per-ticket, and merge stages move verbatim into the orchestrator; `main.ts` logs the iteration header and the iteration outcome.
- README usage lines are updated only where the changed flag and daemon behavior appear; no other documentation work.

## Boundaries

### In scope

- `factory/main.ts` daemon main loop with per-iteration ticket discovery, 0-ticket 10-second sleep, `solveTickets` call, and iteration-outcome log.
- `factory/orchestration/ticket-orchestrator.ts`: `solveTickets` and `solveTicket` implementing the moved ticket loop.
- `factory/tickets/tickets.ts`: one new directory-scanning helper for ticket discovery.
- `factory/shared/sleep.ts`: new 10-second sleep helper.
- `factory/cli/cli.ts`: `--tickets-dir` replaces `--ticket`; help text updated.
- `README.md`: the four usage lines that name `--ticket` and the ten-iteration bound.

### Out of scope

- Any change to `runPlanAgent`, `runImplementationAgent`, `runReviewAgent`, `runMergeAgent`, prompts, `planSchema`, `validatePlan`, `formatTickets`, sandbox provider, Dockerfile, `runGit`, `requirePath`, `requireDirectory`, `MAX_PARALLEL`, harness adapters, proof harness, evaluators, scenarios, fixtures, `package.json`, `tsconfig.json`.
- Signal handling, graceful shutdown, PID files, logging framework, retries, telemetry, ticket-file watching (polling only), concurrency limit changes, persistence of `completed` across process restarts.
- New tests, test framework, CI, refactors of `shared/` or `sandbox/`.

### Must preserve

- Setup order and messages in `main.ts`: `parseArgs` → `resolve(repo)` → `requireDirectory(repo, "Target repository")` → `rev-parse --git-dir` → ticket-directory check → `preflightSandbox` → initial clean-worktree check with the exact message "Target repository must have a clean worktree before Sandcastle starts."
- Planner read-only enforcement, `validatePlan` semantics, per-ticket commit requirement, post-review sandbox cleanliness, merge ancestry verification, and post-merge worktree cleanliness — all with their existing error messages.
- `Promise.allSettled` failure aggregation producing one `Implementation/review failed:\n- ...` error.
- `--repo` single-occurrence rule, `--agent-harness` values (`pi` default, `pi|oh-my-pi`), `--help`/`-h` returning `undefined` without requiring Docker, and the existing unknown-flag/missing-value error style.
- Ticket identity rules: content-hash `id`, `sandcastle/ticket-${id}` branch, duplicate-content rejection.

## Contracts and behavior

- `RunOptions` becomes `Readonly<{ repo: string; ticketsDir: string; agentHarness: AgentHarness }>`.
- `parseArgs` accepts exactly `--repo`, `--tickets-dir`, `--agent-harness`, `--help`, `-h`. `--tickets-dir` requires a value, may be supplied only once, and is required (missing → `Missing required --tickets-dir <markdown-ticket-directory>. Use --help for usage.`). Supplying `--ticket` hits the existing unknown-argument throw.
- `listTicketPaths(dir: string): Promise<string[]>` (new in `factory/tickets/tickets.ts`): `readdir(dir)`, keep entries whose name ends with `.md` case-insensitively, return full resolved paths sorted ascending.
- `sleep(ms: number): Promise<void>` (new in `factory/shared/sleep.ts`): resolves after `ms` via `setTimeout`.
- `solveTickets(repo: string, harness: AgentHarness, iteration: number, pending: readonly Ticket[], completed: ReadonlySet<string>, allTickets: ReadonlyMap<string, Ticket>): Promise<Ticket[]>` (exported from `factory/orchestration/ticket-orchestrator.ts`): runs planner → planner read-only checks → `validatePlan` → `Promise.allSettled` of `solveTicket` per selected ticket → failure aggregation → merge agent → merge ancestry verification → post-merge clean check; returns the implemented tickets.
- `solveTicket(repo: string, harness: AgentHarness, ticket: Ticket): Promise<Ticket>` (module-private in `factory/orchestration/ticket-orchestrator.ts`): opens `await using` sandbox on `ticket.branch`, runs implementation (requires ≥1 commit), runs review, requires clean sandbox, returns the ticket.
- Main loop per pass: increment `iteration`; discover paths; `loadTickets(paths)`; merge into `allTickets` by `id` keeping first occurrence; `pending = [...allTickets.values()].filter(t => !completed.has(t.id))`; if `pending.length === 0` log, `await sleep(TICKET_POLL_MS)`, `continue`; else log iteration header, `const implemented = await solveTickets(...)`, add each implemented `id` to `completed`, log outcome `merged <ids>; <completed.size>/<allTickets.size> ticket(s) completed`.
- Errors thrown inside `solveTickets` propagate out of the loop and terminate the process with a non-zero exit; no catch, no recovery.

## Implementation steps

1. **Add the sleep helper**
   - Files: `factory/shared/sleep.ts`
   - Symbols: `export function sleep(ms: number): Promise<void>`
   - Change: resolve a `setTimeout(ms)` promise; no parameters validated.
   - Preserve: nothing else in `factory/shared/`.
   - Depends on: None.

2. **Add ticket-directory discovery to the tickets module**
   - Files: `factory/tickets/tickets.ts`
   - Symbols: `export async function listTicketPaths(dir: string): Promise<string[]>`
   - Change: `readdir` from `node:fs/promises`, keep names ending `.md` case-insensitively, map to `resolve(dir, name)`, sort ascending, return.
   - Preserve: `loadTickets`, `formatTickets`, `planSchema`, `validatePlan`, `Ticket`, `PlannedTicket` unchanged; `loadTickets` keeps rejecting duplicate paths, non-`.md`, empty, and duplicate content.
   - Depends on: None.

3. **Move the ticket loop into the orchestrator**
   - Files: `factory/orchestration/ticket-orchestrator.ts`
   - Symbols: `export async function solveTickets(repo: string, harness: AgentHarness, iteration: number, pending: readonly Ticket[], completed: ReadonlySet<string>, allTickets: ReadonlyMap<string, Ticket>): Promise<Ticket[]>`; `async function solveTicket(repo: string, harness: AgentHarness, ticket: Ticket): Promise<Ticket>`
   - Change: fill the stub. `solveTickets` body = current `factory/main.ts:37-111` verbatim in order: iteration header log (drop the `/${MAX_ITERATIONS}` bound), `runPlanAgent(repo, harness, iteration, pending, [...completed])`, planner-commits throw, planner clean-worktree throw, `validatePlan(planResult.output.tickets, allTickets, completed)`, empty-selection throw, selected-tickets log, `Promise.allSettled(planned.map((plannedTicket) => solveTicket(repo, harness, allTickets.get(plannedTicket.id) ?? throw)))`, failures throw, merge header log, `runMergeAgent(repo, harness, iteration, implemented)`, per-ticket `merge-base --is-ancestor` verification, post-merge clean-worktree throw, return `implemented`. `solveTicket` body = current `factory/main.ts:61-79`: start log, `await using sandbox = await createSandbox({ cwd: repo, sandbox: sandboxProvider(harness), branch: ticket.branch })`, `runImplementationAgent` with the zero-commit throw, implementation-complete log, `runReviewAgent`, `requireCleanSandbox(sandbox, "Review for ticket ${ticket.id}")`, review-complete log, return `ticket`. Imports: `createSandbox` from `@ai-hero/sandcastle`; `runGit` from `../shared/git.js`; `sandboxProvider`, `requireCleanSandbox`, `type AgentHarness` from `../sandbox/sandbox.js`; `runImplementationAgent`, `runMergeAgent`, `runPlanAgent`, `runReviewAgent` from `../harness/harness-agents.js`; `validatePlan`, `type Ticket` from `../tickets/tickets.js`.
   - Preserve: every existing error message, log string, `await using` disposal, `Promise.allSettled` semantics, and the `planned[index]` failure-label fallback.
   - Depends on: None.

4. **Replace `--ticket` with `--tickets-dir` in the CLI**
   - Files: `factory/cli/cli.ts`
   - Symbols: `RunOptions` (field `ticketsDir: string`, remove `ticketPaths`), `parseArgs`
   - Change: accept `--tickets-dir` alongside `--repo` and `--agent-harness`; enforce single occurrence and required value with messages matching the existing style; require it (`Missing required --tickets-dir <markdown-ticket-directory>. Use --help for usage.`); remove the `ticketPaths` array and the zero-`--ticket` error; update `printHelp` usage line to `--repo <target-repository> --tickets-dir <markdown-ticket-directory>`, replace the "up to ten planning iterations" sentence with continuous daemon polling every 10 seconds, keep the prerequisites paragraph.
   - Preserve: `--repo` single-occurrence rule, `--agent-harness` validation and `pi` default, `--help`/`-h` early return of `undefined`, unknown-flag and missing-value throws.
   - Depends on: None.

5. **Rewrite `main.ts` as the daemon main loop**
   - Files: `factory/main.ts`
   - Symbols: `run()`, `TICKET_POLL_MS = 10_000`; remove `MAX_ITERATIONS`
   - Change: keep setup exactly as `factory/main.ts:19-29` with `resolve(options.ticketsDir)` and `requireDirectory(ticketsDir, "Ticket directory")` inserted after the `rev-parse` check; keep `completed` and `allTickets` (declare `allTickets` as `new Map<string, Ticket>()` populated per iteration); add `let iteration = 0; const stayAlive = true; while (stayAlive) { iteration++; ... }` with the discovery, merge-into-`allTickets`, `pending` filter, 0-ticket sleep-and-continue branch, `solveTickets(repo, options.agentHarness, iteration, pending, completed, allTickets)` call, `completed.add` per implemented ticket, and the iteration-outcome log. Delete the post-loop completion check (lines 114-118) and the final completion log.
   - Preserve: setup order, the initial clean-worktree message, `if (!options) return` for `--help`, and `await run()` at the file end.
   - Remove now-unused imports: `createSandbox`, `runImplementationAgent`, `runMergeAgent`, `runPlanAgent`, `runReviewAgent`, `sandboxProvider`, `requireCleanSandbox`, `validatePlan`. Add imports: `sleep` from `./shared/sleep.js`, `listTicketPaths` from `./tickets/tickets.js`, `solveTickets` from `./orchestration/ticket-orchestrator.js`, `type Ticket` from `./tickets/tickets.js`. Keep `resolve`, `parseArgs`, `preflightSandbox`, `runGit`, `requireDirectory`, `loadTickets`.
   - Depends on: 1, 2, 3, 4.

6. **Update README usage lines**
   - Files: `README.md`
   - Symbols: None
   - Change: line 34 command becomes `npm run sandcastle -- --repo "$RUN_PATH" --tickets-dir samples/tickets --agent-harness oh-my-pi`; line 38 paragraph replaced with the ticket-directory description (the runner polls the directory every 10 seconds, tickets are Markdown files in that directory, one scenario's tickets stay in one directory, never mix tickets from different proof scenarios); line 5 replaces "It keeps ten planning iterations, up to four concurrent implementation/review workers, one reused implementation/review sandbox per branch, and a final merge into the disposable target repository." with continuous iteration, `MAX_PARALLEL = 1` planner selection, per-ticket sandbox, and merge per iteration; line 56 sentence updated to the directory form.
   - Preserve: all other README content, the prerequisites, the proof-scenario table, and the retained-surfaces list.
   - Depends on: 4, 5.

## Caller and dependency updates

- `factory/main.ts:19-32` — reads `options.ticketsDir` instead of `options.ticketPaths`; the only consumer of `RunOptions`.
- `README.md:34,38,5,56` — documents the changed flag and daemon behavior; must match `printHelp`.
- `proof/harness/scenario.ts`, `proof/scenarios/*.json`, `proof/harness/materialize-fixture.ts`, `proof/harness/evaluate.ts` — no change; the `ticket` field is schema-required and unused by the runner.

## Verification

- Command: `npm run typecheck`
- Proves: every moved symbol, new signature, import, and `RunOptions` field change compiles under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` across `factory/main.ts`, `factory/orchestration/ticket-orchestrator.ts`, `factory/cli/cli.ts`, `factory/tickets/tickets.ts`, `factory/shared/sleep.ts`; unused-import removal is covered by the compile of `main.ts`.
- Success evidence: exit code 0 with no diagnostics; additionally `npm run sandcastle -- --help` prints the `--tickets-dir` usage line and exits 0 without Docker, confirming the CLI cutover.
- Not covered: no Docker/model run (requires Docker image `local-sandcastle-runner:latest` and tailnet access to `https://openai.taila49adb.ts.net/v1`), so the live daemon loop, 10-second sleep, planner/implement/review/merge execution, and daemon non-termination are not exercised; no unit tests exist in the repository.

## Executor constraints

- Treat this file as the complete implementation specification; do not reopen the original request or rely on prior conversation.
- Read the named target files before editing, but do not repeat the planner's discovery searches.
- Follow the named files, symbols, contracts, steps, boundaries, and verification command exactly.
- Do not add work not listed under **In scope**.
- If the repository no longer matches a stated finding, stop expanding the search, report the exact discrepancy, and make only the smallest inspection needed to resolve it.
- Load every skill under **Required skills** before editing. Load an additional skill only when new repository evidence makes it applicable; do not use skill loading to restart research.
- After the focused verification passes, stop. Do not run broader checks or continue polishing.
