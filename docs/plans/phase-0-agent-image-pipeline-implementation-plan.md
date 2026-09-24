# Implementation Plan: Phase 0 agent-image pipeline

## Outcome
A reproducible agent-image build pipeline produces and scans one digest-pinned `node-dotnet-playwright` execution image, records immutable inputs, and publishes only the resolved artifact digest for later execution.

## Acceptance criteria
- The Dockerfile uses only lock-backed immutable inputs: `mcr.microsoft.com/playwright/dotnet:v1.62.0-noble` resolved to a committed manifest digest, a checksum-verified Node 22 LTS archive, and no floating package/image input.
- CI builds the image, resolves its pushed OCI digest, scans that digest with Trivy 0.70.0 for HIGH/CRITICAL vulnerabilities, secrets, and image configuration findings, and fails on configured blocking findings.
- The pipeline emits a machine-readable approval record containing the source commit, platform, Dockerfile/input lock hashes, scanner version, scan report path, and final `image@sha256:` reference.

## Required skills
- `vertical-slice-architecture` — governs the pipeline's capability-cohesion boundary: lock validation, build, scan, and approval-record generation stay one traceable workflow contract; downstream consumers use only the public digest/approval-record surface.

## Repository findings
- `docs/roadmap.md: Phase 0` — requires a pinned, scanned agent/runtime image build pipeline and makes the registry digest, not a tag, the approved Phase 3 input.
- `docs/technical-design.md: §6.1` — requires immutable agent-image references in repository manifests.
- `docs/technical-design.md: §8.1` — requires launcher verification of agent-image digest and specifies resource constraints the runtime image must support.
- Official Playwright documentation identifies `mcr.microsoft.com/playwright/dotnet:v1.62.0-noble` as the supported .NET Playwright CI base. The researched manifest exposes .NET SDK 10.0.302 and Playwright browser dependencies.
- Official Trivy documentation identifies `aquasec/trivy:0.70.0` as an official scanner image and supports scanning an image by immutable digest with JSON output.

## Assumptions
- The user approved one combined runtime image: derive from the specified .NET Playwright base and add a checksum-verified Node 22 LTS archive, rather than maintaining two runtime images with mismatched browser versions.
- `agent-images/images.lock` is the authority for the initial resolved MCR manifest digest, Node archive URL/SHA-256, Trivy image digest, and target platform. The executor resolves those current immutable digests once during the implementation commit and commits them before any build; subsequent builds must not resolve mutable tags.
- The initial target platform is `linux/arm64`, matching the workstation; a later trusted change may add a separately locked platform entry.


## Vertical-slice architecture
- The image pipeline is one platform capability: lock inputs, build the runtime image, scan the resolved digest, and emit approval evidence as one traceable workflow contract.
- Keep lock validation, build, scan, and approval-record generation cohesive around observable inputs/outputs. Do not split them into generic technical layers or make the image pipeline own orchestrator workflow state.
- The downstream orchestrator and launcher consume only the public immutable digest and approval-record contract; they must not depend on build-script internals.
- The smoke command is behavioral verification of the runtime-image capability, not a separate product slice.

## Boundaries
### In scope
- Locked image inputs, Dockerfile, build/scan scripts, GitLab CI pipeline, scanner policy, approval-record schema, and a smoke command that verifies required runtime executables.

### Out of scope
- Publishing the selected digest into deployed orchestrator configuration, OCI-packaging agent-assets, launcher Docker lifecycle, network policy, or multi-platform builds.

### Must preserve
- Tags are human-readable metadata only; every consumer uses `image@sha256:`.
- No registry or scanner credentials are copied into the final runtime layer.

## Contracts and behavior
- `images.lock` records each input as `{ name, reference_or_url, sha256, platform }`; the Dockerfile and scripts read exact locked values and reject missing/mismatched hashes.
- `Dockerfile` begins with the lock-resolved MCR digest, installs the locked Node archive after verifying SHA-256, and verifies `dotnet`, `node`, `npm`, and browser-path availability in its final layer.
- `scripts/build-image` builds and pushes a temporary human-readable commit tag, resolves the registry manifest digest, and writes `artifacts/agent-image-approval.json`; it never returns a tag as the approved value.
- `scripts/scan-image` scans the resolved target digest using the locked Trivy image with `--scanners vuln,secret`, image-configuration scanning, JSON report output, and HIGH/CRITICAL failure policy. Database refresh remains an explicit CI input, not a hidden unpinned image mutation.

## Implementation steps
1. **Lock every external build and scan input**
   - Files: `agent-images/images.lock`, `agent-images/scripts/verify-lock`, `agent-images/README.md`
   - Symbols: lock entries `playwright_dotnet_base`, `node_archive`, `trivy`, `platform`.
   - Change: Resolve and commit the immutable MCR base digest, Node archive checksum, Trivy image digest, and `linux/arm64` platform; validate digest/checksum syntax and prohibit tag-only input.
   - Preserve: Do not leave placeholders, mutable `latest` values, or implicit architecture selection.
   - Depends on: None.
2. **Build the combined runtime image deterministically**
   - Files: `agent-images/Dockerfile`, `agent-images/scripts/build-image`, `agent-images/scripts/smoke-runtime`
   - Symbols: image label keys `org.opencontainers.image.revision`, `org.opencontainers.image.base.digest`, `org.opencontainers.image.node.sha256`.
   - Change: Derive from the locked base, add only the verified Node archive and runtime utilities needed by the factory, label input provenance, and smoke-test required executables and Playwright browser directory.
   - Preserve: The final image contains neither registry credentials nor a Docker socket client configuration.
   - Depends on: 1.
3. **Scan the resolved artifact and emit approval evidence**
   - Files: `agent-images/scripts/scan-image`, `agent-images/schemas/agent-image-approval.schema.json`, `agent-images/.gitlab-ci.yml`
   - Symbols: approval record fields `source_commit`, `platform`, `input_lock_sha256`, `image`, `scanner_image`, `scanner_version`, `report`, `status`.
   - Change: Build/push, resolve digest, scan that digest, save JSON evidence, validate the approval record, and publish only the digest output as the downstream artifact.
   - Preserve: A vulnerability/secret/configuration policy failure blocks publication; no mutable tag is exposed as an execution input.
   - Depends on: 2.

## Caller and dependency updates
- `reference-app/agent-image.digest` — consumes the final approved `image@sha256:` reference after the pipeline succeeds.
- `ci-templates` — validates that application manifests use the digest-only reference.
- `launcher/internal/runspec` — later accepts only the published digest value and verifies it before execution.

## Verification
- Command: `./agent-images/scripts/smoke-runtime --lock agent-images/images.lock`
- Proves: the lock is complete, the image builds from immutable inputs, and the produced runtime exposes locked Node/.NET/Playwright requirements.
- Success evidence: exit status 0 and output includes the resolved `image@sha256:` reference.
- Not covered: registry push and Trivy database-backed scan; those require protected CI registry/scanner access and are exercised by the pipeline.

## Executor constraints
- Treat this file as the complete implementation specification; do not reopen the original request.
- Read the named target files before editing, but do not repeat the planner's discovery searches.
- Follow the named files, symbols, contracts, steps, boundaries, and verification command exactly.
- Do not add work not listed under **In scope**.
- If the repository no longer matches a stated finding, stop expanding the search, report the exact discrepancy, and make only the smallest inspection needed to resolve it.
- Load every skill under **Required skills** before editing. Load an additional skill only when new repository evidence makes it applicable; do not use skill loading to restart research.
- After the focused verification passes, stop. Do not run broader checks or continue polishing.
