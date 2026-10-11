/// <reference types="vitest" />
// Landlord portal tests (npm test in apps/landlord; deploy.sh runs them before
// anything ships, after the API and tenant suites).
//
// Its own config rather than vite.config.ts, as in apps/tenant: the app's
// React plugin is ESM-only and cannot load under vitest. Tests need none of
// it — esbuild compiles the JSX, @gam/shared resolves to its TypeScript source
// (the same alias the app's build uses), and component tests get a DOM.
//
// TZ is pinned to the parks' time zone so date labels ("Oct 1", "paid Oct 3,
// 2 days late") read the same on any machine; tests that need another zone
// set it themselves.
import { defineConfig } from 'vitest/config'
import { sharedAlias } from '../../packages/shared/viteSharedAlias.mjs'

export default defineConfig({
  resolve: { alias: sharedAlias },
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    env: { TZ: 'America/Phoenix' },
  },
})
