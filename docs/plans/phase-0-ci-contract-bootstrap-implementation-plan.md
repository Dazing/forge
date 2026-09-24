# Implementation Plan: Phase 0 CI contract bootstrap

## Outcome
A protected CI-template tree and Go `.factory.yaml` validator enforce immutable application contracts before check, build, image, browser, and release-qualification pipeline jobs run.

## Acceptance criteria
- `factory-config-validate` accepts only version 1 manifests whose agent image is digest-pinned, command paths are executable worktree-relative files, image destination remains inside the project registry namespace, services are catalog names, and egress hosts are exact public hostnames.
- Invalid fixtures for mutable images, path escapes, unsupported service names, unsafe egress, unknown keys, inline command arguments, and missing/non-executable scripts fail validation.
- `templates/application-v1.yml` defines the fixed `factory:contract`, `factory:check`, `factory:build`, `factory:image`, `factory:browser`, and `factory:release-qualification` jobs with explicit artifact retention and no deployment credentials.

## Required skills
- `tdd` — use for the manifest-validator fixture matrix before implementing Go validation rules.
- `vertical-slice-architecture` — governs the CI contract's boundary: validator and template composition stay stateless platform infrastructure; each fixed job contract is an observed boundary verified through fixtures; deployment projects remain composition roots for wiring.

## Repository findings
- `docs/roadmap.md: Phase 0` — requires immutable-commit application CI templates, the six named job classes, and a `.factory.yaml` validator rejecting mutable images, path escapes, unsupported services, and unsafe egress.
- `docs/technical-design.md: §6.1` — fixes manifest fields and all manifest rejection rules.
- `docs/technical-design.md: §6.2–§6.3` — fixes immutable include behavior, job names/order, image provenance, and artifact retention.

## Assumptions
- Use a Go validator module at `ci-templates/` with module path `factory.local/platform/ci-templates`.
- The initial protected service catalog contains only `postgres-test` and `redis-test`; unsupported names fail closed until a trusted catalog update adds them.


## Vertical-slice architecture
- The CI contract is a repository-boundary capability: manifest validation, fixed contract jobs, and release-manifest evidence are specified together and verified through observable acceptance behavior.
- `ci-templates` owns the validator and template composition as platform infrastructure. The validator remains stateless and must not contain application feature logic or deployment state.
- Each fixed job contract is an externally observed boundary, not a technical-layer slice. Keep its input/output evidence and rejection behavior close to the template and validator fixtures.
- The reference application consumes only the public `.factory.yaml` and template contract; it must not import validator internals. Trusted deployment projects remain composition roots for deployment wiring.

## Boundaries
### In scope
- `.factory.yaml` schema/validator, fixtures, CI template, contract-script validation, release-manifest schema, and template lint script.

### Out of scope
- GitLab project protection configuration, runner provisioning, actual deployment scripts, registry credential configuration, automatic manual-gate labeling, or production promotion.

### Must preserve
- Application `.gitlab-ci.yml` may only pin an immutable template commit; the template owns reserved `factory:` jobs.
- Application jobs receive only normal CI job tokens; deployment logic and credentials remain outside application checkout execution.

## Contracts and behavior
- `manifest.Manifest` has exactly `version`, `agent.image`, `commands.bootstrap/check/build/browser_test`, `artifacts.image`, `services`, and `network.egress_hosts`; unknown fields fail.
- `agent.image` and all consumed image inputs require `@sha256:` digest syntax; floating tags and image destinations outside the supplied project registry prefix fail.
- Command values are a single repository-relative executable path beginning `./`; absolute paths, `..`, symlink escape, non-executable files, arguments, shell fragments, and missing paths fail.
- Egress values are DNS hostnames only: reject IP literals, wildcards, URL schemes/paths, localhost, RFC1918/tailnet/link-local ranges, GitLab/inference/deployment endpoints, and empty items.
- The template has explicit `expire_in`: ordinary reports 30 days, failed browser evidence 60 days, and release manifest/qualification evidence one year.

## Implementation steps
1. **Define the strict repository-manifest validator**
   - Files: `ci-templates/go.mod`, `ci-templates/cmd/factory-config-validate/main.go`, `ci-templates/internal/manifest/manifest.go`, `ci-templates/internal/manifest/validate.go`, `ci-templates/internal/manifest/validate_test.go`
   - Symbols: `manifest.Load(worktree, path, projectRegistryPrefix string) (Manifest, error)`, `manifest.Validate(manifest Manifest, worktree string, projectRegistryPrefix string) error`.
   - Change: Parse with unknown-field rejection, validate all fixed fields and filesystem constraints, and emit path-specific diagnostics.
   - Preserve: Validation fails closed; it never expands command strings or rewrites manifest values.
   - Depends on: None.
2. **Create conformance fixtures and release-manifest contract**
   - Files: `ci-templates/testdata/{valid,invalid-mutable-image,invalid-path-escape,invalid-service,invalid-egress,invalid-command}/`, `ci-templates/schemas/release-manifest.schema.json`
   - Symbols: release manifest fields `schema_version`, `project_id`, `commit_sha`, `pipeline_id`, `image`, `built_at`, `ci_template_sha`.
   - Change: Add an executable valid script fixture and one focused invalid fixture per rejection class; encode digest-only release-manifest output.
   - Preserve: Example IDs, hosts, SHAs, and digests are test-only illustrative values, never deployment defaults.
   - Depends on: 1.
3. **Create the immutable application CI template**
   - Files: `ci-templates/templates/application-v1.yml`, `ci-templates/scripts/lint-template`, `ci-templates/README.md`
   - Symbols: jobs `factory:contract`, `factory:check`, `factory:build`, `factory:image`, `factory:browser`, `factory:release-qualification`.
   - Change: Make contract precede bootstrap/check, build emit provenance, image resolve and emit the immutable release manifest only on `main`, browser run only when declared, and release qualification consume rather than rebuild the existing digest.
   - Preserve: Do not define deployment credentials/jobs in application pipelines or permit mutable template refs.
   - Depends on: 1, 2.

## Caller and dependency updates
- `reference-app/.factory.yaml` — must conform to this validator and reference the selected image digest only after `agent-images` publishes it.
- `agent-assets/` — its protected pipeline can invoke `factory-assets-validate`; this plan does not own that validator.
- `deploy-staging/` and `deploy-production/` — later trusted projects consume `release-manifest.json`; no application checkout deployment job is added here.

## Verification
- Command: `go test ./ci-templates/...`
- Proves: the validator rejects every required unsafe manifest class and accepts a complete valid repository contract.
- Success evidence: exit status 0 with all CI-contract tests passing.
- Not covered: GitLab's remote CI linter and a live pipeline; `scripts/lint-template` is exercised by its Go test fixture.

## Executor constraints
- Treat this file as the complete implementation specification; do not reopen the original request.
- Read the named target files before editing, but do not repeat the planner's discovery searches.
- Follow the named files, symbols, contracts, steps, boundaries, and verification command exactly.
- Do not add work not listed under **In scope**.
- If the repository no longer matches a stated finding, stop expanding the search, report the exact discrepancy, and make only the smallest inspection needed to resolve it.
- Load every skill under **Required skills** before editing. Load an additional skill only when new repository evidence makes it applicable; do not use skill loading to restart research.
- After the focused verification passes, stop. Do not run broader checks or continue polishing.
