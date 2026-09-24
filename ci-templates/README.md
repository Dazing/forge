# ci-templates

Immutable application CI templates and the `.factory.yaml` validator.

## Validator

The Go module provides `factory-config-validate`, a strict validator for
`.factory.yaml` manifests. It rejects mutable images, path escapes,
unsupported service names, and unsafe egress values.

### Usage

```sh
factory-config-validate -worktree /path/to/app -manifest .factory.yaml -registry-prefix registry.factory.internal/software-factory/apps/myapp
```

### Tests

```sh
go test ./ci-templates/...
```

## CI Template

`templates/application-v1.yml` is the immutable application CI template.
Include it at a pinned commit SHA (never `main` or a tag):

```yaml
include:
  - project: software-factory/platform/ci-templates
    ref: <40-char-sha>
    file: /templates/application-v1.yml
```

The template defines six fixed `factory:` job contracts:

| Job | Stage | Purpose |
|---|---|---|
| `factory:contract` | `factory-contract` | Validates `.factory.yaml` and contract scripts |
| `factory:check` | `factory-check` | Runs bootstrap, then check |
| `factory:build` | `factory-build` | Runs build, emits provenance |
| `factory:image` | `factory-image` | Builds, pushes, and emits `release-manifest.json` (main only) |
| `factory:browser` | `factory-browser` | Runs browser tests when declared |
| `factory:release-qualification` | `factory-qualification` | Consumes existing main digest (release/\* only) |

### Artifact Retention

| Evidence | Retention |
|---|---|
| Ordinary reports | 30 days |
| Failed browser evidence | 60 days |
| Release manifest and qualification evidence | 365 days |

### Lint

```sh
ci-templates/scripts/lint-template
```

Validates that the template defines all six jobs, has no deployment
credentials, and sets `expire_in` on every artifact-producing job.
Exercised by the Go test suite.

## Release Manifest

`schemas/release-manifest.schema.json` defines the JSON Schema for
`release-manifest.json`, the immutable interface between build,
staging, qualification, and production. All consumers require a
digest reference; tags are never deployment inputs.
