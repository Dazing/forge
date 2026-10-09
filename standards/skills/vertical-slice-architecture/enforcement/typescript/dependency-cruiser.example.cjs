/**
 * Vertical Slice Architecture — OPTIONAL dependency-cruiser config
 *
 * eslint-plugin-boundaries is the primary guardrail (it fails the lint step).
 * dependency-cruiser is a complement for YOU in review: it renders the actual
 * dependency graph so slice/feature drift is visible, and it can also fail CI on
 * the headline rules as a second net.
 *
 * Install:
 *   npm i -D dependency-cruiser
 * Graph (needs graphviz):
 *   npx depcruise src --include-only "^src" --output-type dot | dot -T svg > deps.svg
 * Validate:
 *   npx depcruise src --config dependency-cruiser.example.cjs
 *
 * Patterns assume src/features, src/shared. TUNE to your layout.
 */
module.exports = {
  forbidden: [
    {
      name: 'shared-no-features',
      comment: 'shared/ is stateless and must never know about features.',
      severity: 'error',
      from: { path: '^src/shared' },
      to: { path: '^src/features' },
    },
    {
      name: 'no-slice-to-slice',
      comment: 'A slice may not import another slice (cross-feature or not).',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/([^/]+)/' },
      to: {
        path: '^src/features/([^/]+)/([^/]+)/',
        // different slice folder than the source
        pathNot: '^src/features/$1/$2/',
      },
    },
    {
      name: 'cross-feature-via-index-only',
      comment: 'Reach another feature only through its public index.ts.',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/' },
      to: {
        path: '^src/features/([^/]+)/.+',
        pathNot: ['^src/features/$1/', '^src/features/[^/]+/index\\.(ts|tsx)$'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
  },
}
