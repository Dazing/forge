# Implementation task

Implement the single supplied local ticket in the target repository, which is your current working directory.

- Ticket ID: {{TICKET_ID}}
- Title: {{TICKET_TITLE}}
- Branch: {{BRANCH}}

<ticket>
{{TICKET_CONTENT}}
</ticket>

Execute this workflow directly. Work only on this ticket, preserve unrelated behavior, and complete the requested outcome rather than stopping at the first passing increment. This is a local ticket: do not query, update, or close an external issue tracker.

## Operating rules

- The selected agent exposes the supplied skill catalog from its global skills directory (`~/.pi/agent/skills/` for Pi, `~/.omp/agent/skills/` for oh-my-pi). Before editing, load `coding-best-practices` and every other relevant skill and companion file. Load `tdd` for behavioral code with clear inputs and outputs, `csharp` for C# changes, `dotnet-10` for .NET 9/10-sensitive work, and `vertical-slice-architecture` only when the repository adopts or requests it. Repository instructions and established conventions take precedence.
- Resolve ordinary ambiguity with the smallest repository-consistent decision and continue. Never override an explicit requirement. Missing authorization, destructive actions, unavailable credentials, and impossible execution are blockers: report the precise limitation rather than inventing success.
- Preserve public contracts, security, data integrity, and adopted architecture from the first edit. A coherent behavior may span several files when its contract and consumers must change together; do not silently reduce the overall ticket.
- Keep work focused. Do not add speculative validation, retries, telemetry, abstractions, architecture, dependencies, or unrelated cleanup.
- Use tools directly and inspect only to answer a question that affects the next edit or check. Do not invoke another coding controller, create a separate planning document, or repeatedly read unchanged material.

## 1. Ground the contract

Read the requested surface, input/output definitions and comments, affected consumers, closest implementation, and applicable checks. Keep a compact working record in the session, not a repository file:

`ID | requirement source | observable behavior | distinguishing input and expected result | evidence/status`

- Separate explicit requirements, verified dependency facts, and implementation decisions. Include known boundary and failure behavior before coding.
- Derive expected results from the ticket, repository contracts, or verified dependency semantics—never from the implementation being written. Each behavioral scenario must distinguish a plausible wrong implementation.
- For uncertain dependency APIs, establish the effective package version and inspect local usages, type information, source, or authoritative documentation before relying on consequential signatures or semantics. Similar names and successful compilation are not semantic evidence.
- Trace exported-symbol and contract changes through every affected consumer before editing. Reuse existing patterns rather than introducing a competing convention.
- After two unproductive lookups for the same fact, change approach once. If the fact remains unavailable, name the limitation, avoid guessing, and continue only with independent work.

Start implementation as soon as the next coherent behavior is understood. Do not design an exhaustive test suite or idealized architecture first.

## 2. Establish only necessary structure

When required, add the smallest declarations, dependency seams, registration, and project wiring that allow the next behavior to be exercised. Skip this step when the structure already exists.

- Reuse existing files and boundaries. Do not scaffold every possible component or invent a technical-layer architecture.
- Run the narrowest compile or type check covering new structure and fix structural failures before treating a behavioral check as meaningful.
- Temporary declarations or explicit unimplemented bodies may exist only while immediately progressing to real behavior. Never use fake successful responses, fixture-backed production behavior, or permissive security bypasses.
- A compiling skeleton is not completion. Do not commit or report unfinished scaffolding.

## 3. Implement in short verified cycles

### When an applicable test setup exists: RED → GREEN → REFACTOR

For the next uncovered obligation:

1. Add or update one focused check through the narrowest meaningful public boundary.
2. Run it before production implementation. Record the exact command and decisive mismatch. Expected missing behavior is RED; compilation, fixture, package, stale-binary, environment, or generic placeholder failures are not valid RED.
3. Implement the simplest real solution and rerun the identical check. Do not hardcode fixture answers, swallow errors, guess dependency semantics, or weaken the check to obtain GREEN.
4. Run affected earlier checks to preserve established behavior.
5. Refactor only concrete standards violations while checks remain green, then rerun the affected checks.

If a new check already passes, determine whether the behavior exists or the check fails to distinguish the relevant mistake. Preserve correct code; never break it to manufacture RED. Correct an existing check only with independent contract evidence, never merely to match production output.

Do not bulk-author a suite before implementation. Tests must assert observable contracts, boundaries, invariants, transitions, precedence, and errors—not wiring, forwarding, mock echoes, source text, or incidental implementation details.

### When no applicable test setup exists: IMPLEMENT → COMPILE → REFACTOR

Do not introduce a test framework, test project, harness, or temporary executable solely for this ticket. Implement from the grounded contract, run the narrowest successful compile or type check that includes every changed target, fix concrete standards issues, and rerun that check. Compilation proves structural and type correctness only; report any runtime or provider semantics it cannot establish.

Repeat the applicable cycle until every ticket obligation is implemented. Apply repository formatters, linters, analyzers, and broader checks when required by repository policy or a named risk.

## 4. Bounded final review

After known obligations are implemented and verified, review once against the original ticket and repository contracts:

- Map every requirement to the resulting code and evidence. Look for omitted requirements, missed consumers, unsupported dependency assumptions, implementation-shaped expected results, consequential edge cases, and concrete standards violations.
- Require a violated requirement or reproducible failure scenario for each finding; do not invite general redesign.
- Repair supported behavioral findings through another RED/GREEN cycle when applicable tests exist, or IMPLEMENT/COMPILE otherwise. Recheck repaired findings without starting an unrestricted review loop.
- Confirm no provisional skeleton behavior, dead compatibility path, obsolete alias, uncommitted generated output, or task-created disposable scaffolding remains. Update affected documentation when operation or public contracts changed.

## Failure recovery

- For an unexpected failure, record the diagnostic, whether it belongs to production, a check, or the environment, and the violated invariant. Make an evidence-based correction and rerun the same check.
- Allow at most three unsuccessful repair attempts for the same underlying unexpected failure. Renaming the check or changing phases does not reset the count. After the third failure, stop attempts on that cause, preserve the evidence, and finish only genuinely independent in-scope work.
- Preserve command exit status. Never suppress diagnostics, weaken checks, or change unrelated source merely to make a command pass. Distinguish pre-existing or environmental failures from regressions introduced by this ticket.

## Commit and completion

You are already in the reusable sandbox for the deterministic branch named above. Do not create or switch branches.

Before committing, inspect the final diff and worktree state. Load `commit-conventions` when available, then commit all completed source, test, and documentation changes with a concise conforming message. At least one implementation commit is required, and the worktree must be clean.

Finish only when every explicit obligation has evidence, applicable standards are satisfied, existing applicable behavioral checks pass, every changed target compiles or type-checks, review findings are resolved, and no provisional behavior remains.

Give a concise final report containing:

- delivered outcome and changed files;
- consequential decisions or `None`;
- exact verification commands and observed results;
- completed RED/GREEN or IMPLEMENT/COMPILE cycles and unexpected-failure repair counts;
- review findings and disposition;
- remaining blockers or limitations, or `None`.

Do not report success when a command failed, the ticket is incomplete, changes remain uncommitted, or an unresolved blocker exists. On failure, explain the blocker and do not emit the completion signal.

Only after the ticket is fully implemented, relevant checks pass, at least one implementation commit exists, and the worktree is clean, end with:

<promise>COMPLETE</promise>
