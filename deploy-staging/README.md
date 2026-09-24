# deploy-staging

Trusted staging deployment pipeline.

## Contract

- **Input:** `release-manifest.json` — an immutable image digest produced by the app's `factory:image` job.
- **Health check:** Post-deploy target recorded in `staging-deployment.json` for verification.
- **Prohibited:** Cloning the application repository, executing application scripts, rebuilding images.
- **Credentials:** Staging credential supplied by the runner environment (protected masked variable). No credentials in this repository.
- **Runner tag:** `deploy-staging` — restricted to this project only.

## Trigger

- **Automatic:** Orchestrator creates a pipeline in this project after a successful `main` pipeline in the app.
- **Manual:** Developer triggers via GitLab UI.

## Files

| File | Purpose |
|---|---|
| `.gitlab-ci.yml` | Pipeline definition (staging deploy job only) |
