// Single source of truth for the `@gam/shared` → source alias every app's
// vite config uses. Resolving relative to THIS file (not a hardcoded absolute
// path, and not the CJS dist build) keeps it portable across machines + CI and
// guarantees apps consume the TypeScript source, never the fragile dist output.
//
// Usage in an app's vite.config.ts:
//   import { sharedAlias } from '../../packages/shared/viteSharedAlias.mjs'
//   export default defineConfig({ resolve: { alias: sharedAlias }, ... })
import { fileURLToPath } from 'node:url'

export const sharedAliasPath = fileURLToPath(new URL('./src/index.ts', import.meta.url))
export const sharedAlias = { '@gam/shared': sharedAliasPath }
