/**
 * Vertical Slice Architecture — boundary enforcement for the API dialect
 * (TS HTTP services)
 *
 * Same model as the web config; the composition roots are routers + bootstrap
 * instead of pages. Element types map to platforms/typescript/core.md:
 *
 *   shared            stateless infra (db/http clients, middleware) · pure utils
 *   feature           a domain; importable from OUTSIDE only via its index.ts
 *   slice             one endpoint/use-case; may not import another slice
 *   composition-root  routers / app bootstrap; may import features, not the reverse
 *
 * Install:
 *   npm i -D eslint eslint-plugin-boundaries
 *
 * Flat-config fragment (ESLint 9+). Patterns assume src/features, src/shared,
 * routers as *.router.ts and src/app.ts — TUNE to your layout.
 *
 *   // eslint.config.js
 *   const vsa = require('./eslint-boundaries.api.cjs')
 *   module.exports = [ ...vsa ]
 */
const boundaries = require('eslint-plugin-boundaries')

module.exports = [
  {
    plugins: { boundaries },
    settings: {
      // ORDER MATTERS: most specific first.
      'boundaries/elements': [
        { type: 'shared', pattern: 'src/shared/**' },
        // routers and the app bootstrap are composition roots even though they
        // live inside features/ — list them before the slice/feature patterns.
        { type: 'composition-root', pattern: ['src/app.ts', 'src/features/*/*.router.ts'] },
        { type: 'slice', mode: 'folder', pattern: 'src/features/*/*', capture: ['feature', 'slice'] },
        { type: 'feature', mode: 'folder', pattern: 'src/features/*', capture: ['feature'] },
      ],
    },
    rules: {
      'boundaries/element-types': ['error', {
        default: 'disallow',
        rules: [
          { from: 'shared', allow: ['shared'] },

          { from: 'slice', allow: [
            'shared',
            ['feature', { feature: '!${from.feature}' }], // other features (via index)
            ['feature', { feature: '${from.feature}' }],  // own feature (repository, etc.)
          ] },

          { from: 'feature', allow: ['shared', 'slice', 'feature'] },

          { from: 'composition-root', allow: ['shared', 'feature', 'slice'] },
        ],
      }],

      // Cross-feature imports must go through the public index.ts.
      'boundaries/entry-point': ['error', {
        default: 'disallow',
        rules: [
          { target: ['feature'], allow: 'index.ts' },
          { target: ['shared'], allow: '**' },
          { target: ['slice'], allow: '**' },
          { target: ['composition-root'], allow: '**' },
        ],
      }],

      'boundaries/no-unknown': 'error',
      'boundaries/no-unknown-files': 'error',
    },
  },
]
