# Implementation Plan: reference-app Dockerfile public-copy fix

## Outcome
The reference-app image builds without a dangling copy step. The runtime image is produced from the committed source only, and the dead `COPY .../public` line that copies a never-existing source directory is removed.

## Acceptance criteria
- `reference-app/Dockerfile` contains no `COPY` step that references a `/app/public` source.
- The runtime stage still copies the built client (`dist`), the entry `index.html`, and runs `node dist/server/main.js` on port 3000.
- No `public/` directory is introduced into the repo.

## Required skills
- `coding-best-practices` — make the minimal dead-line removal; no new build steps or abstraction.

## Repository findings
- `reference-app/Dockerfile:20` — `COPY --from=builder /app/public ./public` copies `/app/public` from the builder stage. No `public/` directory exists in the repo (confirmed absent), so the COPY source does not exist in the builder image.
- `reference-app/Dockerfile:18` — the runtime stage already copies the built client: `COPY --from=builder /app/dist ./dist`.
- `reference-app/Dockerfile:9` — the builder copies `tsconfig.json tsconfig.server.json vite.config.ts`, `index.html`, and `src` only; it never stages a `public/` directory.
- `reference-app/src/server/app.ts:25-37` — the runtime serves the client via `express.static(distDir)` where `distDir = process.env.CLIENT_DIST ?? <cwd>/dist`, with an SPA fallback that sends `dist/index.html`. The runtime never references a `./public` path.
- `reference-app/vite.config.ts` — sets no custom `outDir` or `publicDir`, so Vite uses defaults (`outDir = dist`, `publicDir = public`). With no `public/` committed, Vite folds nothing and the build emits `dist/`.
- The only `public` reference in the whole `reference-app` tree is `Dockerfile:20`.

## Assumptions
- The reference-app ships no static-only `public/` assets; all client output is produced by the Vite build into `dist/` and served by the runtime `dist` static handler. (If a future `public/` asset set is added, it must be added to the repo and to the builder COPY, not resurrected via a separate runtime `./public`.)

## Boundaries
### In scope
- `reference-app/Dockerfile`: remove the dead `COPY --from=builder /app/public ./public` line.

### Out of scope
- Introducing a `public/` directory or assets.
- Changing the client build, the runtime serving path, or the port/`CMD`.
- The two deferred minor items (orchestrator `webhook_delivery.project_id` FK; reference-app concurrency test).

### Must preserve
- The two-stage build: `npm ci --omit=dev` in both stages, the `dist` copy, the `index.html` copy, `EXPOSE 3000`, and `CMD ["node", "dist/server/main.js"]`.
- The builder stage's copy of `package.json`/lock, `tsconfig*`, `vite.config.ts`, `index.html`, and `src`.

## Contracts and behavior
- The runtime image's filesystem is exactly: production node_modules, the `dist/` client build, and `index.html`. The client is served from `dist/` by the runtime static handler; there is no `./public` runtime path.

## Implementation steps
1. **Remove the dead public copy**
   - File: `reference-app/Dockerfile`, line 20.
   - Delete the single line `COPY --from=builder /app/public ./public`.
   - Preserve: line 18 (`COPY --from=builder /app/dist ./dist`), line 19 (`COPY --from=builder /app/index.html ./`), and lines 21-22 (`EXPOSE 3000` / `CMD ...`).

## Caller and dependency updates
- None. The change is a single Dockerfile line; no build script, test, or runtime code references the removed `./public` path.

## Verification
- Command: `docker build reference-app`
- Proves: the multi-stage image builds end to end with the dead copy removed, and the runtime stage still contains `dist/` and `index.html` as required by `src/server/app.ts`.
- Success evidence: `docker build` completes without an "unable to find context" / missing-source error for the removed step; `docker run --rm <image> sh -c 'test -d /app/dist && test -f /app/index.html'` exits 0.
- Not covered: Docker is not available in this environment, so this cannot be executed here; it is the focused verification for the implementing engineer. The repo's existing browser test (`npm --prefix reference-app run test:browser`) exercises the client build and runtime serving path (2 tests) and already passes, so it is a complementary check that the `dist`-served client still works after the change.

## Executor constraints
- Treat this file as the complete implementation specification; do not reopen the original request.
- Read `reference-app/Dockerfile` before editing, but do not repeat the planner's discovery searches.
- Follow the named file, the single-line removal, and the verification command exactly.
- Do not add work not listed under **In scope**. Do not create a `public/` directory.
- After the focused verification passes, stop. Do not run broader checks or continue polishing.
