---
name: coding-best-practices
description: >-
  Language-independent baseline for writing, modifying, debugging, or reviewing
  production code that remains easy to read, diagnose, test, and maintain. Use
  for implementation work in any language unless a narrower project or language
  skill supersedes it. Covers clarity, control flow, contracts, boundaries,
  errors, dependencies, observability, testing, change safety, performance, and
  security without imposing a specific architecture or style.
---

# Coding Best Practices

Apply this skill whenever work may create or change production code. Its goal is
not stylistic uniformity; it is code that another engineer can understand,
change, and diagnose correctly with minimal hidden context.

## Precedence and scope

Apply guidance in this order:

1. The user's requirements and repository-local instructions.
2. The project's compiler, formatter, linter, analyzer, API, and established
   conventions.
3. Relevant architecture, framework, language, security, and testing skills.
4. This skill where the project is silent.

Do not introduce a second convention beside an established one. Do not churn
correct surrounding code merely to apply a preference from this skill. This is
an implementation baseline, not an architecture, API design, security, or test
methodology replacement.

## Start from behavior and minimize the solution

Before editing:

- Identify the observable behavior to preserve or add, including failure paths.
- Read the surrounding module and trace the affected flow and callers. Reuse the
  codebase's vocabulary and dependency boundaries.
- State or infer the relevant invariants: what must always be true, which inputs
  are trusted, who owns mutable state and resources, and where errors belong.
- Choose the first option that fully satisfies the requirement:
  1. Do not build speculative behavior.
  2. Reuse an existing implementation or established project pattern.
  3. Use the standard library.
  4. Use a native platform capability.
  5. Use an already-installed dependency.
  6. Write the smallest direct implementation that works.
- Minimize owned code and concepts, not merely line count. Never trade away
  correctness, validation, security, accessibility, data integrity, actionable
  errors, or required diagnostics.
- Separate behavior changes from substantial behavior-preserving cleanup when
  combining them would obscure either change.

## Optimize for the reader

Code is maintained through reading. Make the important path obvious on a local
read.

### Names

- Name by domain meaning and role, not storage type or implementation accident.
- Use verbs for operations and nouns for values or concepts. Boolean names
  should read as predicates.
- Keep one term for one concept. Do not alternate synonyms or reuse one term for
  distinct concepts.
- Include units, representation, or scope when ambiguity is plausible, such as
  `timeoutMs`, `encodedPayload`, or `activeUserCount`.
- Avoid unexplained abbreviations, vague containers such as `data`, `info`, or
  `manager`, and misleadingly broad names.

### Structure and control flow

- Prefer ordinary, explicit control flow over dense expressions, clever syntax,
  implicit mutation, and long fluent chains.
- Keep related decisions together and unrelated responsibilities apart. Extract
  a function or type when it creates a meaningful concept, isolates a policy,
  or makes a contract independently understandable—not merely to reduce line
  count.
- Use early returns or guard clauses when they remove nesting without scattering
  the main path.
- Keep state changes visible and ownership clear. Prefer values that cannot be
  mutated after construction when mutation is unnecessary.
- Eliminate duplication of knowledge, not every repeated token. Repetition can
  be cheaper than coupling unrelated behavior behind a premature abstraction.
- Remove dead code and obsolete compatibility paths during a clean cutover.
  Version-control history is the archive.

### Comments and documentation

- Make code explain what it does; use comments for why, constraints, non-obvious
  tradeoffs, external quirks, safety conditions, or algorithmic context.
- Document public contracts: purpose, meaningful inputs and outputs, side
  effects, ownership, failure behavior, and invariants callers must preserve.
- Do not narrate syntax, excuse confusing code, duplicate the type system, or
  leave stale historical commentary in source.
- Update documentation in the same change when users must build, configure,
  call, operate, or troubleshoot the system differently.

## Design narrow, honest boundaries

- Give each module a coherent reason to change. Keep policy separate from I/O
  and external mechanisms when that separation makes behavior easier to reason
  about or test.
- Expose the smallest contract required by real callers. Keep implementation
  details private and dependencies directed through stable, meaningful
  boundaries.
- Prefer explicit data flow and dependencies. Avoid hidden global state,
  service-location patterns, ambient configuration, and action at import or
  construction time unless the platform convention requires them.
- Encode valid states in types or constructors where the language permits. At
  minimum, establish invariants once at the boundary rather than repeatedly
  checking them deep inside trusted code.
- Validate untrusted input at entry points. Normalize once, then pass a
  consistent internal representation.
- Preserve substitutability: an implementation must honor the full behavioral
  contract of the abstraction it implements, including errors and side effects.
- Add an abstraction only after the shared concept and variation are concrete.
  Prefer direct code for a single use case.

## Make failures actionable

- Distinguish expected domain outcomes from exceptional failures using the
  project's established error model.
- Reject invalid state close to its source. Do not continue with sentinel,
  partial, guessed, or silently corrected values unless that recovery is part of
  the contract.
- Catch a failure only to recover, translate it at a boundary, restore an
  invariant, or add context that helps identify the failed operation. Preserve
  the original cause and stack information.
- Error messages should identify the operation, relevant non-secret identifiers,
  and violated constraint. They should not leak credentials, tokens, personal
  data, or internal details across an untrusted boundary.
- Never swallow errors, catch every exception indiscriminately, or log and
  rethrow the same failure at every layer.
- Cleanup must be reliable on success, failure, and cancellation. Make resource
  ownership explicit and release owned resources with the language's structured
  cleanup mechanism.

## Design for diagnosis

Debuggability is a design property, not extra logging added after an incident.

- Preserve causal context across boundaries: operation, stable request or job
  identifier, dependency, attempt, and outcome where relevant.
- Use structured events and stable field names when the project supports them.
  Log decisions and boundary outcomes, not every line of execution.
- Choose one ownership boundary for reporting a failure. Lower layers return or
  propagate it with context; the boundary records it once.
- Keep diagnostics deterministic and actionable. A failing assertion, error, or
  test should make the violated expectation and relevant values visible.
- Make time, randomness, environment, network, filesystem, and external-service
  dependencies explicit when control over them materially improves
  reproducibility.
- Do not expose secrets in logs, traces, metrics, error messages, fixtures, or
  debug output.

When debugging, reproduce the smallest observable failure and follow evidence
to the violated invariant. Trace every affected caller, then repair the
invariant at the narrowest shared boundary rather than patching individual
symptoms. Keep a regression test when the defect represents a durable contract
and the test can be deterministic and maintainable.

## Test contracts, not implementation

- Test externally observable behavior through the narrowest meaningful public
  boundary. Tests should survive a behavior-preserving refactor.
- Cover important success, boundary, transition, and failure behavior. Do not
  optimize for a coverage percentage or mirror every method with a test.
- Prefer assertions on results and resulting state over call choreography.
  Interaction assertions are appropriate when the interaction itself is the
  contract.
- Keep tests deterministic, isolated, concise, and complete enough to understand
  without chasing hidden setup. Failure output must identify what broke.
- Prefer real, fast dependencies where practical; use fakes or stubs at slow,
  nondeterministic, destructive, or out-of-process boundaries. Avoid mocks that
  encode incidental call sequences.
- Treat tests as production code: remove duplication only when the helper makes
  scenarios clearer, not when it hides the values that explain the behavior.

Use the repository's testing workflow and any active testing skill for test
selection and sequencing.

## Handle concurrency and asynchronous work explicitly

- Establish who owns mutable state and which operations may run concurrently.
  Prefer designs that avoid shared mutation; otherwise use the platform's
  established synchronization primitive and document the protected invariant.
- Define cancellation, timeout, ordering, retry, idempotency, and partial-failure
  behavior where they are part of the operation's real contract. Do not add them
  speculatively.
- Never hold a lock across slow or unknown work unless the design requires it
  and the consequences are understood.
- Avoid fire-and-forget work whose lifetime, errors, or cleanup nobody owns.
- Do not assume local execution order proves concurrent correctness. Review
  shared state, reentrancy, race conditions, deadlocks, duplicate delivery, and
  shutdown paths directly.

## Be efficient without obscuring correctness

- First choose an appropriate algorithm, data structure, and I/O shape. Avoid
  repeated work, unnecessary copies, accidental quadratic behavior, unbounded
  growth, and loading complete datasets when streaming or paging is required.
- Do not trade clarity for micro-optimization without evidence from a relevant
  workload. Measure before and after performance-specific complexity.
- Keep optimizations local, explain the measured constraint, and preserve a
  clear correctness oracle or benchmark.
- Treat latency, memory, throughput, startup time, and external calls as separate
  costs. Optimize the one that constrains the user or system.
- A deliberately simple implementation may have a known operational limit.
  Document the limit and the measurable condition that would justify a more
  complex replacement; do not add that replacement preemptively.

## Keep secure defaults at boundaries

- Treat external input, serialized data, configuration, files, and dependency
  responses as untrusted until validated.
- Use platform libraries for authentication, authorization, cryptography,
  escaping, parsing, and secret handling. Do not invent security primitives.
- Authorize the requested action on the server-side trust boundary; successful
  authentication alone is not authorization.
- Use least privilege and minimize retained sensitive data. Make safe behavior
  the default rather than an opt-in configuration.
- Avoid constructing commands, queries, markup, or paths by concatenating
  untrusted values; use parameterized or structured APIs.
- Route security-sensitive work to the project's security guidance or a
  dedicated review. This skill is not a complete threat model.

## Change safely

- Trace every affected caller and contract before changing an exported symbol,
  schema, configuration key, stored representation, or wire format.
- Migrate all in-scope callers and remove obsolete aliases, shims, branches,
  tests, comments, and documentation unless compatibility is an explicit
  requirement.
- Keep diffs focused. Do not mix broad formatting, generated churn, dependency
  upgrades, or unrelated cleanup with a behavioral change.
- Use automated formatters, linters, analyzers, type checkers, and compiler
  diagnostics as enforced project policy—not as substitutes for design review.
- Verify the changed behavior through the real surface, then run the narrowest
  relevant automated checks. Broaden checks according to risk and repository
  guidance.

## Review checklist

Before considering code complete, confirm:

- The behavior and failure paths match the requirement.
- Names, control flow, state changes, and ownership are understandable locally.
- The change follows existing project conventions and adds no speculative
  abstraction or configuration.
- Inputs are validated at the correct boundary; invariants hold internally.
- Errors retain their cause and become actionable exactly once.
- Diagnostics are useful and contain no secrets.
- Resource, cancellation, and concurrency lifetimes are owned.
- Tests protect observable contracts and fail for plausible regressions without
  coupling to implementation details.
- Performance work is proportionate and measured when it adds complexity.
- Existing code, standard-library features, native platform capabilities, and
  installed dependencies were considered before adding new implementation.
- All affected callers, tests, documentation, and obsolete paths are handled.

## Research basis

This baseline synthesizes durable guidance from:

- [Google Engineering Practices: What to Look For in a Code Review](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
- [Software Engineering at Google: Documentation](https://abseil.io/resources/swe-book/html/ch10.html)
- [Software Engineering at Google: Testing Overview](https://abseil.io/resources/swe-book/html/ch11.html)
- [Software Engineering at Google: Unit Testing](https://abseil.io/resources/swe-book/html/ch12.html)
- [Martin Fowler: Refactoring](https://martinfowler.com/books/refactoring.html)
- [Martin Fowler: Code Smell](https://martinfowler.com/bliki/CodeSmell.html)
- [Google Engineering Practices: Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)
- [CISA: Secure by Design](https://www.cisa.gov/resources-tools/resources/secure-by-design)
