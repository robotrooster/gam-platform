/// <reference types="vitest" />
// PM company portal tests (npm test in apps/pm-company).
//
// Its own config rather than vite.config.ts, as in apps/tenant and
// apps/landlord: this package is CommonJS (no "type": "module"), so vitest
// bundles vite.config.ts to require() it, and the app's React plugin and vite
// itself are ESM-only — `npx vitest run` here failed before a single test
// loaded ("vite" resolved to an ESM file), which left OwnersPage.test.ts
// unexecuted. Tests need none of the plugin: esbuild compiles the JSX and
// @gam/shared resolves to its TypeScript source (the same alias the app's
// build uses).
import { defineConfig } from 'vitest/config'
import { sharedAlias } from '../../packages/shared/viteSharedAlias.mjs'

export default defineConfig({
  resolve: { alias: sharedAlias },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
  },
})
