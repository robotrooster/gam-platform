/// <reference types="vitest" />
// Business portal tests (npm test in apps/business; deploy.sh runs them beside
// the API, tenant, landlord and register suites).
//
// 10/31: this app had NO test infrastructure at all — zero files — right up to
// the evening the contractor marketplace gave it a surface that decides money.
// A contractor reads what they keep and what GAM's cut is on this screen, and
// "it typechecks" is not the same as having seen it render.
//
// Its own config rather than vite.config.ts, as in apps/landlord and
// apps/tenant: the app's React plugin is ESM-only and cannot load under
// vitest. Tests need none of it — esbuild compiles the JSX, @gam/shared
// resolves to its TypeScript source (the same alias the app's build uses), and
// component tests get a DOM.
//
// TZ is pinned to the parks' time zone so any date label reads the same on
// every machine.
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
