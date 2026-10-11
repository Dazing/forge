/**
 * Vertical Slice Architecture — boundary enforcement for the WEB dialect
 * (React)
 *
 * Makes the slice boundaries mechanical instead of vibes. Uses
 * platforms/typescript/core.md:
 *
 *   shared            stateless infra · pure utils · dumb components
 *   feature           a domain; importable from OUTSIDE only via its index.ts
 *   slice             one capability; may not import another slice
 *   composition-root  pages/layouts/routes; may import features, never the reverse
 *
 * Install:
 *   npm i -D eslint eslint-plugin-boundaries
 *
 * This is a flat-config fragment (ESLint 9+). Spread it into your eslint.config.
 * Patterns assume src/features, src/shared, src/routes — TUNE to your layout.
 *
 *   // eslint.config.js
 *   const vsa = require('./eslint-boundaries.web.cjs')
 *   module.exports = [ ...vsa ]
 */
const boundaries = require('eslint-plugin-boundaries')

module.exports = [
  {
    plugins: { boundaries },
    settings: {
      // ORDER MATTERS: most specific first (slice before feature).
      'boundaries/elements': [
        { type: 'shared', pattern: 'src/shared/**' },
        { type: 'composition-root', pattern: ['src/routes/**', 'src/app.tsx', 'src/main.tsx'] },
        { type: 'slice', mode: 'folder', pattern: 'src/features/*/*', capture: ['feature', 'slice'] },
        { type: 'feature', mode: 'folder', pattern: 'src/features/*', capture: ['feature'] },
      ],
    },
    rules: {
      // 1. Which element types may depend on which.
      'boundaries/element-types': ['error', {
        default: 'disallow',
        rules: [
          // shared is the floor: it may only see other shared. NEVER features.
          { from: 'shared', allow: ['shared'] },

          // a slice may use shared and OTHER FEATURES (through their public
          // surface — see entry-point rule below). It may NOT import another
          // slice. It may touch its OWN feature's internals (same captured
          // feature) to reach feature-owned state/store.
          { from: 'slice', allow: [
            'shared',
            ['feature', { feature: '!${from.feature}' }], // other features only
            ['feature', { feature: '${from.feature}' }],  // own feature internals
          ] },

          // feature-root files (store/context/index) may use shared, their own
          // slices, and other features' public surface.
          { from: 'feature', allow: ['shared', 'slice', 'feature'] },

          // composition roots arrange everything; nothing imports back into them.
          { from: 'composition-root', allow: ['shared', 'feature', 'slice'] },
        ],
      }],

      // 2. Cross-feature imports must hit the public index.ts, not deep internals.
      //    (Same-feature relative imports still resolve to the same element and
      //    are unaffected.)
      'boundaries/entry-point': ['error', {
        default: 'disallow',
        rules: [
          { target: ['feature'], allow: 'index.{ts,tsx}' },
          { target: ['shared'], allow: '**' },
          { target: ['slice'], allow: '**' },
          { target: ['composition-root'], allow: '**' },
        ],
      }],

      // 3. Every file must classify as one of the element types (catches drift).
      'boundaries/no-unknown': 'error',
      'boundaries/no-unknown-files': 'error',
    },
  },
]
