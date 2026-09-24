# deploy-production

Trusted production deployment pipeline.

## Contract

- **Input:** `release-manifest.json` — the exact qualified OCI digest from a successful `main` pipeline.
- **Trigger:** Manual only. No automatic production job exists. Production is never deployed by the orchestrator merge identity.
- **Health check:** Post-deploy target recorded in `production-deployment.json` for verification.
- **Prohibited:** Cloning the application repository, executing application scripts, rebuilding images, automatic triggers.
- **Credentials:** Production credential supplied by the runner environment (protected masked variable). No credentials in this repository.
- **Runner tag:** `deploy-production` — restricted to this project only.

## Trigger

- **Manual:** A developer explicitly starts the job in GitLab. This is the only way production is deployed.

## Files

| File | Purpose |
|---|---|
| `.gitlab-ci.yml` | Pipeline definition (manual production deploy job only) |
