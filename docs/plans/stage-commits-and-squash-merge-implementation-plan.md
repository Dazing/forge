# Stage commits and squash-merge implementation plan

## Status and outcome

Proposed; not implemented. This plan addresses the stage-traceability item in `docs/roadmap.md`. The hybrid vertical-slice architecture is already implemented and remains unchanged.

Create deterministic Git checkpoints in each retained ticket workspace after implementation and review. Each checkpoint identifies the ticket, attempt, stage, and reported outcome so engineers can isolate stage diffs, inspect review corrections, and correlate them with verification evidence in agent logs. Request squash-on-merge where the provider supports a per-PR preference without merging or enabling auto-merge.

This deliberately changes current commit ownership: agents currently create local commits; after this cutover, agents modify and verify files, return a structured `message`, and the runner creates stage commits. No production changes are part of this planning change.

## Decisions

- The coordinator explicitly sequences `implementation → implementation commit → review → review commit → publication`. No stage registry, generic pipeline context, concurrency, retries, or resumable workflow.
- Exactly one runner-owned commit per successful mutating stage, across all of that stage's agent iterations. Intermediate iterations do not produce commits.
- Create an empty checkpoint when a successful stage changes no files, including a review that finds no issues. Its message must state that outcome. This makes successful review visible in Git rather than indistinguishable from skipped review.
- Failed or incomplete stages do not receive success checkpoints. Retain their dirty workspace and the last successful checkpoint; existing diagnostics identify the failure. Do not commit unfinished code automatically.
- Planning remains read-only in the factory checkout. PR content remains read-only in the ticket workspace. Neither produces a checkpoint: their outcomes belong in invocation/agent logs, not source commits.
- Git execution stays in `factory/infrastructure/git-provider/`; stage policy and checkpoint sequencing belong to `ticket-processing`. Structured output contracts belong to the individual stage features. The generic agent runtime remains unaware of tickets and stage policy.
- Squash preference is not permission to merge. Keep PRs draft, preserve approval/policy checks, and do not enable automatic completion, rewrite repository settings, delete source branches, or squash the retained local history.

## Current contracts to replace or preserve

| Surface | Current behavior | Planned change |
| --- | --- | --- |
| `implement-ticket/implement-prompt.md` | Agent commits completed work before COMPLETE | Agent leaves completed file changes and emits structured `message`; runner commits afterward |
| `implement-ticket/implement-ticket.ts` | Returns `void`; checks completion signal | Returns validated stage-owned output after completion and Git identity checks |
| `review-ticket/review-prompt.md` | Agent commits fixes; no empty commit | Agent leaves verified fixes; reports no findings when appropriate; runner always checkpoints successful review |
| `review-ticket/review-ticket.ts` | Requires a clean workspace immediately after agent execution | Requires valid completed output and unchanged HEAD/branch; cleanliness is enforced after the runner checkpoint |
| `ticket-processing/execute-attempt.ts` | Implement, review, publish | Explicit implementation/review checkpoint boundaries, trace records, and precise failure stage names |
| `publish-pull-request/publish-pull-request.ts` | Counts commits ahead, resolves SHA, pushes, creates draft | Preserve ordering/immutability; add meaningful-tree-change gate because empty checkpoints inflate commit count |
| Provider adapters | Create draft PR only | Azure sets squash completion preference; GitHub explicitly reports unsupported per-draft-PR preference |

Preserve three implementation/review iterations, `<promise>COMPLETE</promise>`, planner `</plan>`, PR `<pull-request>` output, retained fresh workspaces/branches, SSH clone/push, credential isolation/redaction, sequential attempts, and guarded terminal settlement.

## 1. Return structured messages from implementation and review

Add colocated schemas, following existing `planSchema` and `pullRequestSchema` patterns:

- `factory/features/implement-ticket/implement-schema.ts`
- `factory/features/review-ticket/review-schema.ts`

Both schemas accept exactly `{ message: string }`. Use a trimmed nonblank string with a documented 4,000-character limit and reject NUL/control characters other than line feeds. Reject runner-reserved trailer keys so an agent cannot forge stage identity. Do not infer messages from stdout or `RunResult.commits` and do not provide a fallback message for invalid output.

Each feature owns its schema and exported result type. Configure the existing `Output.object` seam with stage-specific tags (`<implementation>` and `<review>`); prompts require one matching JSON block followed by `<promise>COMPLETE</promise>`. Both valid output and the completion signal are necessary for success. Exercise the combination of structured output and bounded iterations through the actual installed Sandcastle runtime before declaring the cutover complete.

The message is a Conventional Commit subject plus a short body describing completed changes, observed verification, and significant findings/disposition. Do not use ticket IDs as scopes. A no-change outcome uses a suitable `chore` subject and explains that no changes were needed. The runner validates the transport and reserved metadata, not the truth of the agent's prose; detailed command evidence remains in the stage log.

Example review output:

```text
<review>
{"message":"fix(reservations): reject duplicate active allocations\n\nResolved the duplicate-allocation finding. Reservation integration tests passed; see the review log for commands and observed results."}
</review>
<promise>COMPLETE</promise>
```

Update both prompts to prohibit local commit creation, amend/reset/rebase/cherry-pick, branch switching/creation, and all existing remote operations. Agents may inspect Git and edit files; only the runner stages and commits them. Prior iterations see the same uncommitted stage work and must continue from it rather than expecting prior agent commits.

Before invoking either agent, require a clean stage-entry workspace and capture HEAD plus symbolic branch. After successful output/completion, require unchanged HEAD and the expected branch. Dirty files at this point are the intended result, not a failure. An agent that commits anyway fails the stage; do not rewrite or adopt its commits. Migrate callers and controlled agent fixtures directly, with no compatibility `void` result or old agent-commit path.

## 2. Create runner-owned checkpoints

Add a small coordinator-private `factory/features/ticket-processing/stage-commit.ts` helper using the existing argv-based Git mechanisms. Do not create another feature or move ticket-aware metadata into infrastructure.

At each successful stage boundary:

1. Recheck expected branch and original HEAD before staging. Require no unresolved merge entries.
2. Stage all completed changes with `git add --all`, covering tracked edits, deletions, renames, and nonignored untracked files. Do not force-add ignored files or silently exclude generated directories. Agents remain responsible for removing unrelated artifacts.
3. Build the commit message from validated agent prose and runner-owned trailers. Reject known provider credential material, including Azure's derived Basic value, before writing a message to Git; never inject credentials or absolute host paths.
4. Run `git commit --allow-empty` with the message as an argv value, not shell interpolation. Preserve hooks and signing configuration; do not use `--no-verify`, inject a fake identity, or disable signing to suppress failures.
5. Read the actual SHA and parent; require exactly one new single-parent commit whose parent is the captured stage-entry HEAD, the expected branch, and a completely clean index/worktree including untracked files.
6. Return the checkpoint SHA and tree-changed flag; advance only after the postconditions pass.

Runner-owned trailers:

```text
Factory-Ticket: <full ticket ID>
Factory-Attempt: <attempt ID>
Factory-Stage: implement|review
Factory-Outcome: complete
Factory-Changes: changed|unchanged
Factory-Agent-Log: <stage log basename>
```

Use a relative log basename, not a machine-specific `.logs` absolute path. Attempt/ticket identity maps this basename back to the invocation logs. Trailers describe runner-observed facts; the message body is agent-reported evidence. Compute `Factory-Changes` from the staged tree versus the parent tree, not from agent claims.

Expose this ownership change in contributor instructions. Missing Git identity, hook failures, signing failures, and dirty-hook outputs are actionable checkpoint failures. Keep the resulting workspace/index/commits intact; do not automatically reset, retry, or clean them.

## 3. Trace checkpoints and failures through the existing workflow

Update `execute-attempt.ts` to call the checkpoint helper explicitly after each stage result, using failure stages `implementation commit` and `review commit`. Review starts only after the implementation checkpoint is clean; publication starts only after the review checkpoint is clean.

For each successful boundary, append a record to the existing `main.log` containing ticket ID, attempt ID, stage, parent SHA, checkpoint SHA, changed/unchanged outcome, and stage log basename. Add only the generic optional record fields needed to serialize this through `InvocationLogger`; ticket-aware record assembly stays in the coordinator. Record read-only PR-content success at the existing workspace SHA after its immutability check. Existing planner logs remain the planning evidence.

A trace-write failure after a commit must not cause another commit: fail the attempt once and retain that commit. Existing settlement remains guarded; later annotation/movement failures never republish. Preserve the original `CommandFailedError` when checkpoint commands fail.

Add an append-only stage-checkpoint annotation through the public `tickets/index.ts`, showing stage, parent/checkpoint SHA, changed/unchanged outcome, and log reference. Append after a checkpoint succeeds, including on attempts whose next stage fails. Annotation failure receives a distinct stage and stops further stages; do not retry the checkpoint. Keep full messages/evidence in Git/logs instead of duplicating large bodies in ticket files.

Compound-engineering analysis should need only retained artifacts:

- Use `git log --format=full` to find stage trailers and outcome summaries.
- Use `git diff <implementation-parent> <implementation-sha>` to isolate implementation.
- Use `git diff <implementation-sha> <review-sha>` to isolate review fixes, including an empty result for successful no-change review.
- Correlate ticket/attempt/stage with agent logs to inspect verification, findings, and recurring corrections.

No automatic learning loop, prompt rewriting, new database, dashboard, or external telemetry is included.

## 4. Prevent checkpoint-only publication

Empty stage commits mean the existing commits-ahead check is insufficient to prove a publishable change.

Keep the existing `commit count` substage and its check. Before `final SHA` and push, add a `change set` publication substage requiring a nonempty net tree diff from `origin/<baseBranch>` to HEAD. This rejects attempts containing only empty checkpoints and attempts whose review undoes every implementation change. Use actual Git tree comparison, not commit-message parsing or a count of nonempty commits.

Keep the PR-content HEAD/porcelain comparison unchanged and feed its agent the checkpoint history so it can explain implementation and review outcomes. PR output remains title/body only. The final SHA is the review checkpoint SHA, including when review had no file changes. Push all stage history unchanged; never squash locally.

Update `PublicationSubstage`, settlement consumers, and behavior tests for the new failure classification without losing current substages or unwrapping behavior.

## 5. Request squash-on-merge within provider capabilities

Use an explicit `mergeStrategy: "squash"` publication request field. Return a provider-neutral `squashPreference: "configured" | "unsupported"` result field, so the caller reports the actual capability rather than claiming every draft has been configured. Do not add alternate merge strategies or configuration flags that have no requested consumer.

### Azure DevOps

The REST 7.1 create endpoint accepts `completionOptions`, including `mergeStrategy: "squash"`. Include this with `isDraft: true`; set `deleteSourceBranch: false` and `bypassPolicy: false`. Do not set `autoCompleteSetBy` or completed status, and do not use deprecated `squashMerge`.

Validate returned draft state and squash completion option before reporting `configured`. If necessary, use one read-back request to verify persisted state; absence or mismatch is a structured draft-publication failure, not silent success or a retry without squash. Retain the pushed branch and any created PR on verification failure, as with other publication failures. Record a known created PR URL in failure diagnostics when available. Repository branch policies still govern eventual completion; this preference does not override them.

### GitHub

The documented draft-PR create/update REST APIs have no per-PR merge-method preference. `merge_method: "squash"` belongs to the merge operation, which is outside this runner's draft-publication authority.

Create the draft normally and return `unsupported`. Record the limitation in the completion annotation/log and add a short runner-owned PR-body note requesting squash merge; reserve space within the existing body limit. Do not send ignored fields, enable GraphQL auto-merge, mark the PR ready, invoke a merge endpoint, or edit repository-wide settings. Operators can allow/enforce squash through their existing repository governance; this plan does not change it.

Propagate the result through publication and completion annotation without changing terminal outcome ownership. Maintain API versions, encoded Azure segments, fully qualified branch refs, browser-facing URLs, authentication, and raw/derived credential redaction.

## 6. Verification and acceptance

Keep tests colocated, using real temporary Git repositories and controlled agent/provider seams. Cover observable behavior rather than prompt wording or import forwarding.

- Completed implementation produces one checkpoint containing tracked changes, deletions, and nonignored new files; review starts from its exact SHA and a clean workspace.
- Review fixes produce a second single-parent checkpoint with only the review delta. No-finding review produces an empty second commit with a truthful no-change message/metadata.
- Multiple agent iterations still yield one checkpoint per successful stage. Missing completion, malformed/blank/oversized message, forged trailers, unexpected agent commits, or branch changes fail without runner success checkpoints or publication.
- Incomplete review retains the implementation checkpoint and dirty review work, settles once to `failed/`, and never pushes.
- Git identity, hook/signing, stage annotation, and trace-write failures identify the boundary, preserve diagnostics/artifacts, and do not repeat a commit or recursively settle.
- Checkpoint-only and net-zero changes fail at `change set` before push/provider HTTP.
- PR-content mutation still fails. A successful attempt pushes the review checkpoint SHA, annotates both stage checkpoints plus the final SHA/PR URL, and moves to `done/`.
- Azure HTTP tests prove squash preference, draft state, no auto-complete/policy bypass/source deletion, response/read-back validation, and credential-safe failures. GitHub tests prove draft creation with unsupported preference and no merge/settings/auto-merge request.
- Existing publication and post-publication settlement behavior remains intact, including completed outcomes when completion annotation/movement fails.

Run focused tests during implementation, then from the root:

```bash
npm run verify
npm run sandcastle -- --help
```

Exercise a disposable bounded iteration through `processTickets` with real Markdown tickets, temporary working repositories/bare remote, real logging, controlled stage outputs, and each provider HTTP seam. Observe actual stage diffs/trailers, clean boundary state, pushed SHA, PR payload/result, terminal annotations/files, and failed-review settlement. Remove disposable drivers afterward.

Separately exercise structured stage output with the installed Sandcastle runtime for both configured harnesses where Docker/model prerequisites are available. Controlled integration is not live agent or provider proof. Test live Azure persisted squash preference only against an explicitly authorized disposable repository; do not merge it. Report unavailable external prerequisites separately rather than inferring success from fixtures.

## 7. Documentation and clean cutover

During implementation, update both `README.md` and `AGENTS.md`: runner commit ownership, stage output tags/messages, empty checkpoints, clean-workspace gate timing, trace-analysis commands, `change set` substage, and provider squash limitations. Remove obsolete agent-commit instructions and migrate every affected test fixture/provider stub directly. Do not rewrite historical plans, move runtime assets, or alter unrelated proof scenarios.

Keep this proposal confined to `docs/plans/` until the production cutover is implemented and verified. Only then update README and contributor instructions to describe the actual behavior.

## References

- [Roadmap](../roadmap.md)
- [GitHub REST: create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request), [update a pull request](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request), and [merge a pull request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request): draft publication has no merge-method field; the merge operation does.
- [Azure DevOps REST 7.1: create a pull request](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.1): draft state and completion options are request fields; `mergeStrategy` supports `squash` independently of `autoCompleteSetBy`.
- [Azure completion options](https://learn.microsoft.com/en-us/javascript/api/azure-devops-extension-api/gitpullrequestcompletionoptions): prefer explicit merge strategy over deprecated `squashMerge`; target-branch policy remains authoritative.
