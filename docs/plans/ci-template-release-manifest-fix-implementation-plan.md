# Implementation Plan: ci-templates release-manifest and contract fixes

## Outcome
The application CI template emits a schema-valid release manifest, threads a real registry namespace into contract validation, and its validator rejects reserved factory control-surface egress hosts. The `factory:image` digest is a `sha256:` manifest digest (not a bare image ID), `factory:contract` validates against a non-circular registry namespace, and the `factory:browser` gate is driven by the manifest rather than an unset variable.

## Acceptance criteria
- `ci-templates/templates/application-v1.yml` `factory:image` resolves the pushed manifest digest with `sha256:` and passes the `release-manifest.schema.json` image pattern.
- `factory:contract` passes `FACTORY_REGISTRY_NAMESPACE` (not the image destination) as `-registry-prefix` and fails closed when it is empty.
- `factory:browser` runs whenever `factory:check` runs and self-skips when no browser command is declared; the dead `FACTORY_BROWSER_POLICY` gate is gone.
- `factory-config-validate` rejects an egress host that is a reserved factory control-surface endpoint.
- `lint-template` still reports exactly six `factory:*` jobs, six `expire_in` directives, and no deployment credential/job references.
- `go test ./ci-templates/...` passes.

## Required skills
- `coding-best-practices` — keep the validator additions (reserved-host rejection) and the template script edits minimal and consistent with the existing fail-closed style; no new abstraction.

## Repository findings
- `ci-templates/templates/application-v1.yml:106` — `DIGEST="$(docker inspect --format='{{.Id}}' "$IMAGE")"` emits a bare 64-hex image ID with no `sha256:` prefix. Lines 107-112 emit `"image":"$FACTORY_IMAGE_DEST@$DIGEST"`, which fails the schema.
- `ci-templates/schemas/release-manifest.schema.json:31` — the `image` pattern is `^@sha256:[0-9a-f]{64}$|^[^@]+@sha256:[0-9a-f]{64}$`, so `image` must carry a `sha256:` digest.
- `agent-images/scripts/build-image:64-65` — the grounded digest-resolution reference: `docker buildx imagetools inspect "$temp_tag" | sed -n 's/.*DIGEST \(sha256:[0-9a-f]\{64\}\).*/\1/p' | head -n1` yields `sha256:<64hex>`.
- `ci-templates/templates/application-v1.yml:50` — `factory:contract` passes `-registry-prefix "$FACTORY_IMAGE_DEST"`. `FACTORY_IMAGE_DEST` (line 36) is the full image destination, so the namespace containment check is a no-op in the real CI path (the Go validator's `registryPrefix` unit test at `validate_test.go:10` uses a fixed external prefix and never catches this).
- `ci-templates/cmd/factory-config-validate/main.go:30-34` — an empty `-registry-prefix` already exits non-zero; the guard here is what makes a missing CI variable fail closed.
- `ci-templates/templates/application-v1.yml:136-137` — `factory:browser` has `rules: - if: $FACTORY_BROWSER_POLICY == "enabled"`. That variable is set nowhere in the template or any application, so the job never runs. The in-script guard at line 129 (`if [ -z "$FACTORY_BROWSER_TEST" ]; then exit 0; fi`) already handles the declared/not-declared case.
- `ci-templates/internal/manifest/validate.go:25-33` — `internalSuffixes` (`".internal"`, `".local"`, `".lan"`, `".home.arpa"`, `".arpa"`, `".corporate"`, `".intranet"`) plus the suffix loop at `validate.go:236-240`. `unsafeEgressHost` (`validate.go:213-256`) rejects IP literals, localhost, wildcards, and those suffixes, but does not reject reserved factory control-surface endpoints.
- `docs/technical-design.md:478` — the firewall blocks GitLab, hypervisors, deployment networks, and inference hosts; the design does not enumerate concrete hostnames.
- `ci-templates/scripts/lint-template` — asserts all six `factory:` jobs (`contract check build image browser release-qualification`), no `DEPLOY_(STAGING|PRODUCTION)_*` / `deploy_(staging|production):` references, and exactly six `expire_in:` directives. Exercised by `ci-templates/scripts/lint-template_test.go` (`TestLintTemplate_Valid` → `sh lint-template application-v1.yml`).

## Assumptions
- **Registry namespace is a new required CI variable.** Each application defines `FACTORY_REGISTRY_NAMESPACE` (its image namespace, e.g. `registry.factory.internal/software-factory/apps`) in its own `.gitlab-ci.yml`. The manifest's `artifacts.image` must live inside that namespace. No manifest or schema change is required; the validator containment logic is already correct.
- **Egress reserved-host list (thin; follow-up acceptable).** The reserved factory control-surface endpoints are recorded as `gitlab.factory.internal` and `registry.factory.internal`, chosen from the repo's own `.internal` namespace convention (`registry.factory.internal` is the real registry host already used by `registryPrefix` at `validate_test.go:10`). The mechanism is a small exact-hostname set; the concrete list may be expanded later.
- The template now requires `docker buildx` (`imagetools inspect`) in addition to the runner prerequisites already listed at `application-v1.yml:15` (`sh, yq, docker, jq, curl`).

## Boundaries
### In scope
- `ci-templates/templates/application-v1.yml`: `factory:image` digest resolution, `factory:contract` registry-prefix argument + fail-closed guard, `factory:browser` gate, and the runner-prerequisites comment.
- `ci-templates/internal/manifest/validate.go`: a reserved control-surface egress-host set and its check in `unsafeEgressHost`.
- `ci-templates/internal/manifest/validate_test.go`: one new test for a reserved control-surface egress host.

### Out of scope
- Changing `validate.go`'s `validateImageDestination` containment logic (already correct; the registry fix is purely the input source).
- Any live pipeline, registry, or Docker execution.
- The two deferred minor items (orchestrator `webhook_delivery.project_id` FK; reference-app concurrency test).

### Must preserve
- Exactly six `factory:*` jobs, six `expire_in` directives, and no deployment credential/job references in the template (lint-template invariants).
- The `factory:browser:` job name and its `expire_in: 60d`.
- Fail-closed behavior: an empty registry namespace must stop `factory:contract`.

## Contracts and behavior
- `factory:image` resolves `DIGEST` as `sha256:<64hex>` via `docker buildx imagetools inspect "$IMAGE"` (mirror `agent-images/scripts/build-image:64-65`), guards against an empty result, and emits `image` as `$FACTORY_IMAGE_DEST@$DIGEST`, matching `release-manifest.schema.json:31`.
- `factory:contract` calls `factory-config-validate -registry-prefix "$FACTORY_REGISTRY_NAMESPACE"`; when `FACTORY_REGISTRY_NAMESPACE` is empty the job exits non-zero before invoking the validator.
- `factory:browser` has no `rules:` block; it is scheduled by `needs: [factory:check]` and self-skips when `FACTORY_BROWSER_TEST` is empty.
- `unsafeEgressHost` rejects any host in the reserved control-surface set and returns a `network.egress_hosts[i]` `ManifestError`.

## Implementation steps
1. **Fix the release-manifest digest in `factory:image`**
   - File: `ci-templates/templates/application-v1.yml`, `factory:image` script (lines 94-113).
   - Replace line 106 `DIGEST="$(docker inspect --format='{{.Id}}' "$IMAGE")"` with the buildx-manifest-digest resolution and an empty guard:
     ```sh
     DIGEST="$(docker buildx imagetools inspect "$IMAGE" \
       | sed -n 's/.*DIGEST \(sha256:[0-9a-f]\{64\}\).*/\1/p' | head -n1)"
     [ -n "$DIGEST" ] || { echo "could not resolve pushed manifest digest for $IMAGE" >&2; exit 1; }
     ```
   - Keep lines 107-112 (`image` = `$FACTORY_IMAGE_DEST@$DIGEST`) unchanged.
   - Update the runner-prerequisites comment at line 15 to list `docker buildx` alongside `docker`.
   - Preserve: `factory:image` keeps its `rules: - if: $CI_COMMIT_BRANCH == "main"` and `expire_in: 365d`.

2. **Thread the registry namespace into `factory:contract`**
   - File: `ci-templates/templates/application-v1.yml`, `factory:contract` script (lines 44-51).
   - Before the `factory-config-validate` call, add the fail-closed guard:
     ```sh
     [ -n "$FACTORY_REGISTRY_NAMESPACE" ] || { echo "FACTORY_REGISTRY_NAMESPACE is required; refusing to validate with an empty registry namespace" >&2; exit 1; }
     ```
   - Change line 50 from `-registry-prefix "$FACTORY_IMAGE_DEST"` to `-registry-prefix "$FACTORY_REGISTRY_NAMESPACE"`.
   - Preserve: the `factory:contract` `needs`-free precedence (it runs first) and its `artifacts`/`expire_in: 30d`.

3. **Remove the dead `factory:browser` gate**
   - File: `ci-templates/templates/application-v1.yml`, `factory:browser` (lines 135-141).
   - Delete the two-line block `rules:` / `- if: $FACTORY_BROWSER_POLICY == "enabled"` (lines 136-137). The job keeps `needs: [factory:check]`, the in-script guard, `artifacts`, and `expire_in: 60d`.
   - Preserve: the `factory:browser:` job name and its `expire_in: 60d`.

4. **Reject reserved control-surface egress hosts**
   - File: `ci-templates/internal/manifest/validate.go`.
   - After `internalSuffixes` (line 33) add:
     ```go
     // reservedEgressHosts are exact factory control-surface endpoints a public
     // egress host must never address (GitLab, image registry, inference hosts).
     var reservedEgressHosts = map[string]bool{
         "gitlab.factory.internal": true,
         "registry.factory.internal": true,
     }
     ```
   - In `unsafeEgressHost`, immediately after the `internalSuffixes` loop (line 240), add:
     ```go
     if reservedEgressHosts[lower] {
         return fmt.Sprintf("egress host %q is a reserved factory control-surface endpoint", host), true
     }
     ```
   - Preserve: all existing rejections (IP literals, localhost, wildcards, suffixes) are unchanged.

5. **Add the reserved-host test**
   - File: `ci-templates/internal/manifest/validate_test.go`.
   - Add `TestLoad_InvalidEgressControlSurface` mirroring `TestLoad_InvalidEgress` (line 179) but with `egress_hosts: [gitlab.factory.internal]`, asserting the error field is `network.egress_hosts[0]` via `assertManifestError`.

## Caller and dependency updates
- Each application's `.gitlab-ci.yml` (consumers of the pinned `application-v1.yml`) must now define the required variable `FACTORY_REGISTRY_NAMESPACE` (its image namespace). This is the caller obligation the new template contract imposes; it is a documentation/variable requirement, not an in-repo file change.
- No in-repo application `.gitlab-ci.yml` consumes the template yet (the repo contains only `deploy-production/`, `deploy-staging/`, and `agent-images/` CI files), so no in-repo caller file is edited.

## Verification
- Command: `go test ./ci-templates/...`
- Proves: the manifest validator rejects reserved control-surface egress hosts and still accepts the valid fixture (`TestLoad_Valid`); `TestLintTemplate_Valid` confirms the edited template still has six `factory:*` jobs, six `expire_in`, and no deployment references.
- Success evidence: exit status 0 with all `ci-templates` tests passing, including the new `TestLoad_InvalidEgressControlSurface`.
- Not covered: live registry digest resolution (`docker buildx imagetools inspect` against a real registry) and end-to-end `FACTORY_REGISTRY_NAMESPACE` threading through a real pipeline; these are verified structurally by the schema pattern, the validator unit tests, and `lint-template`, not executed.

## Executor constraints
- Treat this file as the complete implementation specification; do not reopen the original request.
- Read the named target files before editing, but do not repeat the planner's discovery searches.
- Follow the named files, symbols, contracts, steps, and verification command exactly.
- Do not add work not listed under **In scope**.
- After the focused verification passes, stop. Do not run broader checks or continue polishing.
