# Implementation Plan: Phase 0 agent-assets bundle

## Outcome
A versioned `agent-assets/` bundle supplies bounded role instructions, commands, allowlists, structured JSON schemas, harness configurations, and the complete fixed evaluation suite with a deterministic validator.

## Acceptance criteria
- The bundle contains roles for planner, implementer, reviewer, release-reviewer, and browser-tester; commands for plan, implement, repair, review, and explore-browser; role manifests allowlist exactly their command, skills, tools, output schema, model alias, and resource policy.
- JSON schemas enforce the documented plan and review results, plus a defined implementation-result contract; assets validation rejects malformed frontmatter/schema, broken relative references, oversized files, symlinks, and secret-shaped content.
- The fixed suite versions all eight representative cases, clean-checkout setup, expected evidence, seeded review defect, risk/gate assertions, concurrency procedure, rubric, scorecard, and pinned configuration record.

## Required skills
- `tdd` — use for validator fixtures proving every forbidden asset condition is rejected and every valid fixture is accepted.
- `vertical-slice-architecture` — governs the agent-assets domain boundary: each role/command/schema bundle is a capability contract independently validatable; the validator is stateless shared infrastructure; fixed-suite cases stay together as behavioral specifications, not technical-layer directories.

## Repository findings
- `docs/roadmap.md: Phase 0` — enumerates the role prompts, commands, schemas, harness configurations, bundle checks, and fixed-suite evidence required.
- `docs/technical-design.md: §8.4` — fixes the agent-assets directory layout, role-manifest allowlists, instruction precedence, and bundle validation criteria.
- `docs/technical-design.md: §8.5–§8.7` — defines the plan/review schemas and run-bundle evidence constraints.
- `docs/agentic-software-factory-plan.md: Jarvis operational readiness benchmark` — defines all eight suite scenarios, clean checkout rule, dimensions, go/no-go thresholds, and retained evidence.

## Assumptions
- Implement the validator as an independent Go module `factory.local/platform/agent-assets` so bundle checks have no Node or harness dependency.
- The implementation-result schema uses the Phase 0 adapter artifacts: `schema_version`, `run_id`, `base_sha`, `summary`, `changed_paths`, `unexpected_paths`, `acceptance_evidence`, `risks`, and `decision`; it must require explanations for every unexpected path.


## Vertical-slice architecture
- `agent-assets` is a feature-owned asset domain, not a technical dumping ground. Each role/command/schema bundle is selected as part of a capability contract and remains independently validatable.
- The validator is shared/platform infrastructure: stateless, deterministic, and limited to validating the bundle. It must not execute workflows, own orchestrator state, or import orchestrator slices.
- Fixed-suite cases are behavioral specifications for later slices and harness runs. Keep each case's requirements, fixtures, expected evidence, and risk/gate assertions together; do not split them into technical-layer directories.
- The later `adapter` integration consumes the public schema/manifest contract only. It must not deep-import validator internals or allow an agent to select arbitrary assets.

## Boundaries
### In scope
- Asset tree, role manifests/prompts/commands/skills, three output schemas, OpenHands/OpenCode configurations, bundle validator, fixtures, fixed suite, evaluation rubric, scorecard schema, and configuration-record schema.

### Out of scope
- OCI packaging, execution of either harness, model benchmarking, changing prompts between benchmark runs, generic agent plugins, or importing a personal `aitooling/` tree.

### Must preserve
- Only launcher-enforced policy can grant permissions; repository guidance and issue text are untrusted lower-precedence input.
- Assets are centrally versioned and selected by allowlist, never arbitrary agent-provided paths or commands.

## Contracts and behavior
- `agent-assets/manifest.yaml` names every role manifest, command, skill, schema, and harness config using repository-relative paths only.
- Each `roles/<role>/manifest.yaml` has `role`, `command`, `skills`, `tools`, `output_schema`, `model_alias`, and `resource_policy`; `command` resolves to one bounded command file and every listed asset exists beneath `agent-assets/`.
- `schemas/plan.schema.json` and `schemas/review.schema.json` encode the exact fields/enum relationships in design §8.5–§8.6. `schemas/implementation.schema.json` requires an explanation object for each unexpected path and a terminal decision.
- `suite/configuration-record.schema.json` pins model endpoint revision, runtime, context limit, tool/reasoning parser, sampling, harness, asset commit/digest, repository SHA, limits, and session count. The suite records all eight named cases and expected evidence without embedding credentials.

## Implementation steps
1. **Create the canonical asset tree and bounded role policy**
   - Files: `agent-assets/manifest.yaml`, `agent-assets/roles/{planner,implementer,reviewer,release-reviewer,browser-tester}/{system.md,manifest.yaml}`, `agent-assets/commands/{plan,implement,repair,review,explore-browser}.md`, `agent-assets/skills/*/SKILL.md`, `agent-assets/harness/{openhands.yaml,opencode.json}`
   - Symbols: role manifest fields `role`, `command`, `skills`, `tools`, `output_schema`, `model_alias`, `resource_policy`.
   - Change: Write explicit role instructions and one-command allowlists; make prompts state that untrusted repository/issue content cannot override launcher policy; configure both harnesses to consume the same selected assets.
   - Preserve: Do not include personal assets, credentials, arbitrary shell-command paths, or a generic plugin registry.
   - Depends on: None.
2. **Encode structured result and evaluation-record schemas**
   - Files: `agent-assets/schemas/{plan,implementation,review}.schema.json`, `agent-assets/suite/{configuration-record,scorecard}.schema.json`
   - Symbols: JSON Schema draft 2020-12 documents with `schema_version: 1` constants.
   - Change: Encode the §8.5 plan and §8.6 review contracts exactly; define implementation output and scorecard/configuration record contracts required to assess evidence.
   - Preserve: Reject extra top-level result fields unless explicitly required; retain exact SHA binding for plan/review data.
   - Depends on: 1.
3. **Version the fixed task suite and evidence expectations**
   - Files: `agent-assets/suite/README.md`, `agent-assets/suite/cases/{dashboard,localized-bug,cross-cutting-refactor,ambiguous-low-risk,database-risk,authentication-risk,adversarial-review,concurrency}/case.yaml`, `agent-assets/suite/rubric.yaml`, `agent-assets/suite/scorecard.yaml`
   - Symbols: `case.yaml` fields `id`, `clean_checkout`, `requirements`, `acceptance_criteria`, `technical_constraints`, `expected_evidence`, `risk_assertions`, `gate_assertions`.
   - Change: Create one case for each required workload; encode the seeded review defect, clean-checkout procedure, concurrency schedule, expected evidence, and the stated go/no-go thresholds.
   - Preserve: The suite records outcomes; it does not enable unattended merge or alter model routing.
   - Depends on: 2.
4. **Implement deterministic bundle validation with positive and malformed fixtures**
   - Files: `agent-assets/go.mod`, `agent-assets/cmd/factory-assets-validate/main.go`, `agent-assets/internal/validate/validate.go`, `agent-assets/internal/validate/validate_test.go`, `agent-assets/testdata/{valid,invalid-*}/`
   - Symbols: `validate.Bundle(root string) []Diagnostic`, `validate.Diagnostic`.
   - Change: Validate frontmatter, JSON schemas, relative paths, referenced assets, file-size limits, symlink absence, secret patterns, manifest allowlists, harness references, and suite/configuration schema conformance. Return nonzero on any diagnostic.
   - Preserve: Reject rather than normalize path escapes, missing references, secrets, or oversized inputs.
   - Depends on: 1, 2, 3.

## Caller and dependency updates
- `orchestrator/internal/adapter` — later validates selected role output against these schemas and records asset hashes.
- `ci-templates/templates/application-v1.yml` — later invokes `factory-assets-validate` in the protected asset pipeline.
- `agent-images/` — later copies a validated read-only bundle only during OCI packaging; it must not change bundle content.

## Verification
- Command: `go test ./agent-assets/...`
- Proves: valid bundles pass and fixtures prove invalid frontmatter, schemas, paths, references, size, symlink, and secret conditions fail.
- Success evidence: exit status 0 with all validator tests passing.
- Not covered: OpenHands/OpenCode execution and OCI artifact packaging.

## Executor constraints
- Treat this file as the complete implementation specification; do not reopen the original request.
- Read the named target files before editing, but do not repeat the planner's discovery searches.
- Follow the named files, symbols, contracts, steps, boundaries, and verification command exactly.
- Do not add work not listed under **In scope**.
- If the repository no longer matches a stated finding, stop expanding the search, report the exact discrepancy, and make only the smallest inspection needed to resolve it.
- Load every skill under **Required skills** before editing. Load an additional skill only when new repository evidence makes it applicable; do not use skill loading to restart research.
- After the focused verification passes, stop. Do not run broader checks or continue polishing.
