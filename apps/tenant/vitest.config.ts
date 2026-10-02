/// <reference types="vitest" />
// Tenant portal tests (npm test in apps/tenant; deploy.sh runs them before
// anything ships).
//
// Its own config rather than vite.config.ts: the app's React plugin is
// ESM-only and cannot load under vitest. Tests need none of it — esbuild
// compiles the JSX, @gam/shared resolves to its TypeScript source (the same
// alias the app's build uses), and component tests get a DOM.
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
