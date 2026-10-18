/// <reference types="vitest" />
// 10/13 (Nic): the admin portal's own tests (the Metrics map first), set up the
// way apps/landlord and apps/tenant are: their own config rather than
// vite.config.ts, because the app's React plugin is ESM-only and cannot load
// under vitest. esbuild compiles the JSX, @gam/shared resolves to its
// TypeScript source (the alias the app's build uses), and component tests get
// a DOM.
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
