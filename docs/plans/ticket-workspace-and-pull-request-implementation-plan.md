# Implementation Plan: Ticket workspaces and draft pull requests

## Outcome

The factory owns one fresh, retained Git workspace per selected ticket. Tickets identify their GitHub repository and base branch in YAML front matter; after planning, deterministic TypeScript clones the repository into `.workspaces/`, creates a local ticket branch, runs implementation and review there, preserves agent commits, commits any remaining changes, pushes only after successful implementation, and creates a draft GitHub pull request from structured content produced by a renamed pull-request agent.

Observable result: `npm run sandcastle -- --tickets-dir <dir>` processes each root-level Markdown ticket independently. A successful ticket is annotated with its workspace, branch, final commit, and draft PR URL and moved to `<dir>/done/`. A ticket-level failure is annotated with detailed diagnostics, moved to `<dir>/failed/`, and does not stop remaining tickets. Workspaces and any remote branch created before a later failure are retained.

## Acceptance criteria

- Ticket files start with strict YAML front matter containing required `name` and `repository`, plus optional `baseBranch` defaulting to `main`:

  ```yaml
  ---
  name: fix-login-redirect
  repository: git@github.com:acme/app.git
  baseBranch: main
  ---
  ```

- Only `git@github.com:<owner>/<repository>.git` repositories are accepted. GitHub Enterprise, HTTPS repositories, and local-path repositories are rejected as ticket-level metadata failures.
- `name` is normalized once to lowercase kebab-case using only ASCII letters, digits, and hyphens; an empty normalized name is invalid.
- After the planner selects a ticket, the factory generates one six-character lowercase hexadecimal attempt ID, records it in the ticket, and uses it consistently in `.workspaces/<ticket-slug>-<attempt-id>/` and `agent-tickets/<ticket-slug>-<attempt-id>`.
- Workspace setup is TypeScript-owned and performs a fresh, non-shallow, single-base-branch clone followed by creation of the local ticket branch. It performs no install, restore, build, or other repository-specific bootstrap command.
- The implementation and review agents run against that ticket's workspace. Agents may read Git state and create local commits, but prompts prohibit push, remote branch deletion, and GitHub API/CLI operations.
- The old merge agent is cleanly renamed and refactored to a pull-request agent. It no longer merges branches; it returns strict structured `commitMessage`, `title`, and `body` values after implementation/review.
- Existing agent-created commits are preserved. If tracked or untracked changes remain, TypeScript stages all changes and creates one additional commit using the generated commit message.
- A ticket with no commits ahead of `origin/<baseBranch>` after finalization is failed and is never pushed.
- Only TypeScript may run remote-affecting operations. It pushes the ticket branch with upstream tracking and creates a draft PR targeting the configured base branch through the GitHub REST API.
- `GITHUB_TOKEN` is loaded from the factory-root `.env` file and validated before polling starts. A missing `.env`, missing token, or blank token is an invocation-level startup failure. `--help` remains usable without credentials.
- Git push uses the repository's SSH URL and host SSH configuration. The token is used only for the GitHub API; it is never placed in Git arguments, URLs, logs, ticket diagnostics, or agent environments.
- A successful ticket gets a Markdown completion section containing timestamp, attempt ID, retained workspace path, branch, final commit SHA, base branch, and draft PR URL, then moves to `<tickets-dir>/done/`.
- Any metadata, setup, implementation, review, finalization, push, or PR-creation failure gets one Markdown failure section containing timestamp, failed stage, sanitized command/operation, exit code or HTTP status, stdout, and stderr. The same detailed failure is written to the invocation `main.log`; the ticket moves to `<tickets-dir>/failed/`; processing continues.
- If push succeeds but PR creation fails, the remote branch is retained. No rollback or remote deletion is attempted.
- All local workspaces are retained on success and failure. Cleanup is out of scope.

## Required skills

- `coding-best-practices` — module boundaries, explicit side effects, diagnostics, secret handling, and clean cutovers.
- `tdd` — deterministic ticket parsing, workspace Git behavior, and ticket lifecycle behavior have clear input/output contracts and should be implemented in focused red/green cycles.

## Repository findings

- `factory/main.ts:18-53` currently requires `--repo`, validates one pre-existing repository, retains tickets in memory, and treats `solveTickets` failures as invocation-fatal. Per-ticket repositories require removal of the global target-repository setup and terminal file movement as the durable completion mechanism.
- `factory/cli/cli.ts:7-70` exposes `RunOptions.repo` and requires `--repo`; this becomes obsolete once repository ownership moves into ticket metadata.
- `factory/tickets/tickets.ts:11-17` currently models only `id`, derived title, path, full content, and a deterministic `sandcastle/ticket-<id>` branch. It has no front-matter parser or lifecycle metadata.
- `factory/tickets/tickets.ts:40-79` loads a whole batch and throws on the first invalid ticket, which would terminate polling. Loading must become per-file so malformed tickets can be failed and processing can continue.
- `factory/tickets/tickets.ts:65` hashes the complete original file. Ticket annotations therefore must happen only after the ticket is selected; the in-memory ID/content for that processing attempt remain based on the pre-annotation source.
- `factory/tickets/tickets.ts:95-138` and `factory/prompts/plan-prompt.md` currently require the planner to echo a branch before the ticket is selected. Because the attempt ID and final branch are created post-planning, the planner contract must select by immutable `id` and `title` only.
- `factory/orchestration/ticket-orchestrator.ts:9-99` creates Sandcastle worktrees from one global repository, requires implementation commits, aggregates failures into a throw, invokes `runMergeAgent`, and verifies merges into global `HEAD`. This flow must become a ticket-local setup/implement/review/finalize/publish pipeline.
- `factory/harness/harness-agents.ts:127-220` runs planning in the target repository, implementation/review in a reusable branch sandbox, and a mutating merge agent. Planning now occurs before a ticket repository exists; implementation/review can use the fresh clone's checked-out branch with Sandcastle's head strategy, while the replacement pull-request agent must be read-only and structured-output-only.
- `factory/prompts/merge-prompt.md` explicitly instructs the LLM to merge branches and run Git mutations. It must be replaced, not retained as a compatibility path.
- `factory/shared/git.ts:11-17` handles only `git -C <repo>` and drops subprocess exit/stdout/stderr details behind a generic error. Workspace clone and required ticket diagnostics need a structured command failure that preserves those fields.
- `factory/harness/harness-agents.ts:16-22` privately creates the invocation log directory. A shared invocation logging module is needed so agent logs and `main.log` use the same run directory.
- `package.json` has no YAML parser or test command. `zod` already exists for schema validation; use the maintained `yaml` package for front matter rather than implementing a partial YAML parser.
- Node 24 is the documented runtime, so `process.loadEnvFile()` can load the root `.env` without adding a dotenv dependency.
- `.gitignore` does not ignore `.env` or `.workspaces/`; both must be ignored. `.logs/` also is not currently ignored despite runtime output and should be added with the new generated workspace path.
- `README.md:30-59` documents the obsolete pre-materialized `--repo` workflow, global target repository, merge agent, and fatal stage behavior.
- No language server is configured for this TypeScript workspace. Exported merge-agent references were therefore traced through repository search: the declaration in `factory/harness/harness-agents.ts` and its import/call in `factory/orchestration/ticket-orchestrator.ts`; README and prompt references also require migration.

## Decisions and assumptions

- “Factory root” means the repository root containing `factory/`, `.logs/`, and the new `.workspaces/`; workspace paths are not created inside `factory/workspace/`.
- Attempt IDs use `randomBytes(3).toString("hex")`. If the candidate workspace path already exists, generate another ID before annotating the ticket; never reuse or delete an existing directory.
- The original ticket filename is preserved when moving to `done/` or `failed/`. If that filename already exists at the destination, append `-<attempt-id>` before `.md` rather than overwrite trace evidence.
- The YAML front matter is removed from the body supplied as `Ticket.content`; the original complete source is retained for hashing and file annotation.
- `title` remains the first Markdown H1, falling back to `name`. The dedicated `name` field controls only slug/path/branch identity.
- `baseBranch` is validated as a single valid Git branch name during setup with `git check-ref-format --branch`; absence maps to `main` before the trusted `Ticket` value is constructed.
- Planning remains pre-workspace and therefore cannot inspect a selected ticket repository. Update the planning prompt to select/dependency-order from ticket content only. Run it from the factory root, snapshot factory `HEAD` and worktree status before/after, and reject any planner mutation.
- The current planner limit `MAX_PARALLEL = 1` remains unchanged. The lifecycle types should still be ticket-scoped and not rely on serial execution.
- The pull-request agent runs after review but before optional final commit so it can describe both committed and remaining changes. Snapshot `HEAD` and status around this agent and fail if it changes either.
- GitHub owner/repository are parsed from the validated SSH URL. Draft PR creation uses `POST https://api.github.com/repos/{owner}/{repo}/pulls` with `draft: true`, `head: <ticket branch>`, and `base: <baseBranch>`.
- A fine-grained token needs repository Metadata read and Pull requests write. SSH credentials independently need permission to push the branch; startup validates only token presence, while SSH failures remain ticket-scoped.
- Ticket failure reporting sanitizes the literal token from every message/stdout/stderr before either sink. Lower layers return structured failures; the orchestrator records each terminal failure exactly once.
- Invalid ticket files are assigned an attempt ID for correlation but do not receive a workspace. When front matter is too malformed to derive `name`, diagnostics use the source filename plus attempt ID.
- Global failures remain fatal: CLI errors, missing/blank `GITHUB_TOKEN`, sandbox preflight failure, unreadable ticket directory, planner failure/mutation, and inability to initialize the invocation logger. Failures after a specific ticket is selected or while validating one discovered ticket are ticket-scoped.

## Boundaries

### In scope

- YAML front matter and strict ticket metadata validation.
- Ticket slugging, post-planning attempt identity, lifecycle annotations, and movement into `done/` or `failed/`.
- A new `factory/workspace/workspace-service.ts` implementing clone/base checkout/local branch setup with TypeScript-run Git commands.
- Shared structured command failures sufficient for Git diagnostics.
- Per-ticket orchestration against retained workspaces.
- Clean rename/refactor from merge agent/prompt to pull-request agent/prompt.
- TypeScript-owned optional commit, SSH push, and GitHub draft-PR creation.
- Root `.env` loading and startup validation of `GITHUB_TOKEN`.
- Shared invocation directory plus `main.log`.
- Focused deterministic tests, CLI/help/docs updates, and generated-path ignores.

### Out of scope

- Workspace or remote-branch cleanup, retention limits, retries, resumability, or retrying tickets already in `failed/`.
- Repository-specific install/build/bootstrap hooks during workspace setup.
- HTTPS Git remotes, GitHub Enterprise, non-GitHub providers, forks, PR reviewers/labels/assignees, auto-merge, or converting the draft to ready-for-review.
- Remote rollback when finalization partially succeeds.
- Token acquisition/rotation, SSH key management, credential helpers, or validating repository permissions at startup.
- Combining or merging multiple tickets into one branch/PR.
- Changing the planner concurrency limit, adding a queue database, file watching, telemetry, or a general job framework.
- Migrating the standalone proof fixtures/evaluators to hosted GitHub repositories. Their current pre-materialized-local-repository runner command becomes obsolete and must not remain documented as a supported end-to-end factory invocation.

### Must preserve

- Continuous ticket-directory polling and deterministic sorted root-level `*.md` discovery.
- `--agent-harness` values/default and `--help` behavior.
- Sandbox preflight before any agent stage.
- Planner selection validation for unknown, duplicate, completed, or mutated ticket identity.
- Implementation and review completion-signal enforcement and relevant repository checks performed by those agents.
- Agent logs under the invocation-specific `.logs/<timestamp>-<pid>/` directory.
- The rule that agents cannot query or mutate an external issue tracker.

## Contracts and behavior

### Ticket model

`Ticket` becomes a validated immutable value with:

```ts
type Ticket = Readonly<{
  id: string;
  name: string;
  slug: string;
  title: string;
  path: string;
  content: string;
  repository: string;
  githubOwner: string;
  githubRepository: string;
  baseBranch: string;
}>;
```

`PlannedTicket` contains only `id` and `title`. A post-planning `TicketAttempt` composes `ticket`, `attemptId`, `workspacePath`, and `branch`; do not mutate `Ticket` to add runtime state.

`loadTicket(path)` parses exactly one file and either returns a validated `Ticket` or throws a typed metadata error carrying the source path and structured stage details. `loadTickets` no longer owns batch-fatal behavior; the poller maps individual files through `loadTicket` and settles each result.

### Workspace service

`createWorkspace(input)` in `factory/workspace/workspace-service.ts`:

1. Validate `baseBranch` with `git check-ref-format --branch`.
2. Create `.workspaces/` if absent and reserve a fresh `<slug>-<attempt-id>` directory without deleting any existing path.
3. Execute `git clone --origin origin --branch <baseBranch> --single-branch <repository> <workspacePath>` using `execFile`, never a shell command string.
4. Execute `git -C <workspacePath> switch -c <branch>`.
5. Verify `HEAD` names `<branch>` and `origin` equals the ticket SSH URL.
6. Return the immutable workspace descriptor. Leave every partial directory in place on failure.

The service does not run install/build commands, contact the LLM, push, or create a PR.

### Pull-request finalization

`runPullRequestAgent(workspacePath, harness, attempt)` returns strict Zod-validated output:

```ts
type PullRequestOutput = Readonly<{
  commitMessage: string;
  title: string;
  body: string;
}>;
```

All three values are trimmed and non-empty. The prompt instructs the agent to inspect the actual `origin/<baseBranch>...HEAD` diff and worktree, produce content only, and perform no Git or GitHub mutation.

TypeScript finalization then:

1. If `git status --porcelain` is non-empty, run `git add --all` and `git commit -m <commitMessage>`; otherwise preserve existing commits without creating an empty commit.
2. Require at least one commit in `origin/<baseBranch>..HEAD`; zero commits is a ticket failure.
3. Resolve the final SHA with `git rev-parse HEAD`.
4. Run `git push --set-upstream origin <branch>`.
5. Call the GitHub REST API with the startup-loaded token and create a draft PR.
6. Append completion metadata and move the ticket to `done/`.

A non-2xx GitHub response is a structured failure whose HTTP status occupies `exitCode`, response text occupies `stdout`, and transport diagnostics occupy `stderr`. The diagnostic command is a sanitized `POST https://api.github.com/repos/<owner>/<repo>/pulls`; headers and token are never rendered.

### Ticket lifecycle

Create `done/` and `failed/` lazily under the supplied ticket directory. Lifecycle annotations are append-only Markdown sections separated from ticket content. Use fenced text blocks for stdout/stderr so command output cannot corrupt heading structure.

- Attempt section: timestamp, attempt ID, workspace path, branch, repository, base branch.
- Completion section: timestamp, attempt ID, workspace path, branch, base branch, final SHA, draft PR URL.
- Failure section: timestamp, attempt ID, stage, sanitized command/operation, exit code/HTTP status, stdout, stderr.

The orchestrator owns the terminal transition. If annotation or movement itself fails, write that error to `main.log`; attempt the remaining safe transition once without recursion. Never overwrite a destination ticket.

### Invocation logging and configuration

Move invocation-root creation out of `harness-agents.ts` into a shared logging module. It exposes the run directory to agent file logging and an append-only `main.log` writer. Main-log records include ISO timestamp, ticket/attempt identifiers when available, stage, operation, status, stdout, and stderr.

After CLI parsing and before polling:

1. Resolve the factory root from module location, not caller CWD.
2. Load `<factory-root>/.env` with `process.loadEnvFile`.
3. require non-blank `process.env.GITHUB_TOKEN`.
4. Initialize invocation logging and sandbox preflight.

Pass the token explicitly into the GitHub service; do not let lower modules read ambient environment state.

## Implementation steps

1. **Add focused test infrastructure and YAML dependency**
   - Files: `package.json`, `package-lock.json`.
   - Add `yaml` as a pinned runtime dependency and a `test` script using Node's test runner through `tsx` for `factory/**/*.test.ts`.
   - Keep the existing `sandcastle`, proof, evaluate, and typecheck scripts.
   - Depends on: none.

2. **Define structured command execution failures**
   - Files: `factory/shared/git.ts` and focused tests if needed through workspace behavior.
   - Add an immutable failure shape containing operation, display command, exit code, stdout, stderr, and original cause. Preserve `runGit` for repository-local commands but implement it on the structured `execFile` boundary; add the clone-capable command entry point required by the workspace service.
   - Never use shell interpolation. Normalize Node `ExecFileException` fields without losing output.
   - Depends on: none.

3. **Centralize invocation paths and main logging**
   - Files: new `factory/shared/invocation-log.ts`, `factory/harness/harness-agents.ts`.
   - Create one `.logs/<timestamp>-<pid>/` per invocation, expose agent log paths, and append structured human-readable records to `main.log`.
   - Move the existing private `runLogPath`/`fileLogging` path ownership to this module while preserving per-agent log names.
   - Add token redaction at the final logging/annotation boundary.
   - Depends on: none.

4. **Upgrade ticket parsing and identity**
   - Files: `factory/tickets/tickets.ts`, new `factory/tickets/tickets.test.ts`.
   - Parse leading YAML front matter with `yaml`; validate via a strict Zod schema; default `baseBranch` to `main`; validate exact GitHub SSH shape and derive owner/repository; normalize `name` to a slug; use H1 or `name` as title; expose body-only prompt content.
   - Replace eager `branch` with metadata fields, change `PlannedTicket`/`planSchema` to `id` and `title`, and update `formatTickets` accordingly.
   - Tests: default base branch, explicit base branch, slug normalization, SSH URL rejection, missing fields, malformed front matter, body extraction, and planner identity validation without branch.
   - Depends on: 1.

5. **Add ticket lifecycle persistence**
   - Files: new `factory/tickets/ticket-lifecycle.ts`, new `factory/tickets/ticket-lifecycle.test.ts`.
   - Add attempt/success/failure annotation functions and collision-safe movement to `done/`/`failed/` using filesystem rename on the same ticket directory.
   - Tests use temporary directories and assert meaningful resulting file location/content, destination collision preservation, and fenced diagnostics; do not assert incidental whitespace beyond the documented Markdown contract.
   - Depends on: 3, 4.

6. **Implement the workspace service**
   - Files: new `factory/workspace/workspace-service.ts`, new `factory/workspace/workspace-service.test.ts`.
   - Define `TicketAttempt`/`Workspace` contracts, secure six-hex attempt generation, path reservation, base-branch validation, fresh clone, local branch creation, and postconditions.
   - Integration test with temporary local source and bare-origin repositories exercises real Git commands through the service boundary: selected base branch is cloned, expected ticket branch is checked out, source history exists, and a second attempt produces a distinct retained directory. URL-policy validation remains in ticket parsing, allowing this local deterministic Git fixture.
   - Depends on: 2, 4.

7. **Refactor agent stages around ticket workspaces**
   - Files: `factory/harness/harness-agents.ts`, `factory/prompts/plan-prompt.md`, `factory/prompts/implement-prompt.md`, `factory/prompts/review-prompt.md`.
   - Run planning from factory root before workspace setup; remove repository-inspection instructions and branch echo from planner output.
   - Run implementation and review against the fresh clone's currently checked-out branch using Sandcastle's head branch strategy rather than asking Sandcastle to create another worktree branch.
   - Update prompts to allow local Git reads/commits but explicitly forbid push, remote mutations, `gh`, and direct GitHub API calls.
   - Preserve completion-signal enforcement and per-stage file logging.
   - Depends on: 3, 4, 6.

8. **Replace merge agent with pull-request content agent**
   - Files: `factory/harness/harness-agents.ts`, rename `factory/prompts/merge-prompt.md` to `factory/prompts/pull-request-prompt.md`.
   - Remove `runMergeAgent` and `Merge` terminology entirely. Add `pullRequestSchema`, `PullRequestOutput`, and `runPullRequestAgent` returning structured content.
   - The new prompt describes content generation only, includes ticket/base/branch context, and prohibits filesystem, Git, and remote mutation. Enforce unchanged `HEAD` and worktree around the run.
   - Update all call sites and docs; no alias or legacy prompt remains.
   - Depends on: 7.

9. **Add deterministic GitHub publication**
   - Files: new `factory/github/pull-request-service.ts`, focused `factory/github/pull-request-service.test.ts` only for response parsing/error normalization if a deterministic fetch seam is needed.
   - Parse/use the owner/repository already validated on `Ticket`; POST the draft PR through built-in `fetch`; use GitHub's JSON accept header, bearer token, and API version header; validate the success payload contains `html_url` and PR number.
   - Do not add Octokit or invoke `gh`. Keep push in the orchestration Git path so SSH and API authentication remain explicit and separate.
   - Depends on: 2, 4.

10. **Rewrite ticket orchestration as an independent lifecycle**
    - Files: `factory/orchestration/ticket-orchestrator.ts`.
    - Keep planner invocation/validation global for the iteration. For each selected ticket: generate/persist attempt identity, create workspace, run implementation and review, run pull-request content agent, commit remaining changes if any, reject no-change branches, push, create draft PR, annotate success, move to `done`, and return a successful result.
    - Catch failures only around a known ticket attempt; normalize/log/annotate/move once; return a failed result so other tickets continue. Delete merge aggregation, branch merging, merge ancestry checks, and global target-worktree checks.
    - Snapshot planner factory `HEAD`/status before and after to preserve read-only planning.
    - Depends on: 3, 5, 6, 7, 8, 9.

11. **Cut the composition root over to ticket-owned repositories**
    - Files: `factory/main.ts`, `factory/cli/cli.ts`.
    - Remove `--repo` and `RunOptions.repo`; usage becomes `npm run sandcastle -- --tickets-dir <dir> [--agent-harness ...]`.
    - After `--help` handling: resolve/validate ticket directory, load root `.env`, require `GITHUB_TOKEN`, initialize logger, and run sandbox preflight.
    - Discover and load each root ticket independently. Immediately fail/move invalid tickets without terminating the invocation. Keep terminal ticket IDs out of later planning during the process lifetime; moved files naturally stay out after restart.
    - Continue polling after successful and failed ticket results. Keep directory-read/planner/startup failures fatal.
    - Depends on: 3, 4, 5, 10.

12. **Update operational files and documentation**
    - Files: `.gitignore`, new `.env.example`, `README.md`; update any maintained example ticket chosen for documentation.
    - Ignore `.env`, `.logs/`, and `.workspaces/`; document `GITHUB_TOKEN=` without a value in `.env.example`.
    - Document ticket front matter, GitHub.com/SSH prerequisites, fine-grained token permissions, separate SSH push authorization, workspace retention, lifecycle folders, failure diagnostics, draft PR behavior, and the new CLI.
    - Replace merge-agent/global-repository claims and remove the obsolete supported `--repo` invocation. Clearly state that current local proof fixtures/evaluators are not an end-to-end remote-publication smoke path.
    - Depends on: 1-11.

## Caller and dependency updates

- `factory/main.ts` — no global repository argument; passes factory root, ticket directory, harness, logger, and startup token into orchestration.
- `factory/cli/cli.ts` — remove every `repo` field/flag/help/error branch.
- `factory/tickets/tickets.ts` — all consumers migrate from `ticket.branch` to `TicketAttempt.branch`; planner schema and prompt stop echoing branches.
- `factory/harness/harness-agents.ts` — implementation/review signatures receive workspace context; `runMergeAgent` becomes `runPullRequestAgent` with a structured result.
- `factory/orchestration/ticket-orchestrator.ts` — sole owner of ticket terminal transitions and remote publication sequence.
- `factory/prompts/*.md` — planner reflects pre-workspace constraints; implementation/review prohibit remote writes; merge prompt is removed and replaced.
- `README.md`, `.env.example`, `.gitignore` — operational contract and generated/secret paths match runtime behavior.
- `package.json`, `package-lock.json` — add only `yaml` and the focused test script; no GitHub SDK or dotenv dependency.

## Verification

1. `npm test`
   - Proves front-matter defaults/validation, slug rules, planner identity contract, append-and-move lifecycle behavior, collision safety, token sanitization behavior, and real local Git clone/base/branch setup.
2. `npm run typecheck`
   - Proves the clean ticket/attempt type split, removed global `repo` option, renamed agent API, Zod outputs, Node env loading, fetch response handling, and all caller migrations compile under strict TypeScript settings.
3. `npm run sandcastle -- --help`
   - Proves help is available without `.env`, Docker, or a GitHub token and documents only `--tickets-dir` plus harness options.
4. Startup smoke with a temporary factory-root `.env` omission or blank token.
   - Proves the process exits before polling/sandbox work with the required actionable `GITHUB_TOKEN` error. Restore/remove the temporary file immediately after the smoke.
5. Ticket-failure smoke using a temporary tickets directory containing one malformed ticket and one syntactically valid ticket whose SSH clone is guaranteed to fail.
   - Proves malformed/setup failures are annotated, moved to `failed/`, recorded in `main.log`, and do not terminate processing before the second ticket is handled; confirms partial workspace retention where clone created it.
6. Live success smoke, when disposable GitHub repository credentials are available: process one ticket against a disposable `github.com` repository and observe the checked-out local ticket branch, pushed remote branch, draft PR base/head/title/body, completion annotation, `done/` move, and retained workspace.
   - This is the only verification that proves SSH authentication and the real GitHub API contract. If credentials/repository are unavailable, report this exact unverified boundary; do not substitute a mocked success claim.

## Executor constraints

- Treat this plan as the complete implementation specification; do not reopen product decisions settled here.
- Use deterministic TypeScript APIs for clone, branch, optional commit, push, and PR creation. LLM output is data (`commitMessage`, `title`, `body`), never authority to choose or execute remote operations.
- Never log or append `GITHUB_TOKEN`; sanitize at both main-log and ticket-annotation sinks.
- Do not delete workspaces or remote branches on any path.
- Do not add setup hooks, retries, provider abstractions, Octokit, dotenv, or compatibility aliases.
- Migrate all affected callers and delete obsolete merge code/prompt/docs in the same cutover.
- Before editing exported TypeScript symbols, use language-server references if a TypeScript language server becomes available; otherwise re-run the focused reference search because none was available during planning.
- Run focused tests, then typecheck, then the specified smoke scenarios. Stop after documented verification; do not mutate a non-disposable GitHub repository.
