// A production build of a portal must know where the API is. Every portal
// falls back to http://localhost:4000 when VITE_API_URL is unset — right for
// `vite dev`, and silently broken in production: the live site sends every
// request to the visitor's own machine (S655: the Support console shipped
// that way and nobody could sign in). This makes the build stop instead.
//
// VITE_API_URL may come from the app's .env.production(.local) (vercel pull)
// or the build's environment (CI); Vite's loaded env covers both.
//
// Usage in an app's vite.config.ts:
//   import { requireApiUrl } from '../../packages/shared/viteRequireApiUrl.mjs'
//   export default defineConfig({ plugins: [react(), requireApiUrl()], ... })
export function requireApiUrl() {
  return {
    name: 'gam-require-api-url',
    configResolved(config) {
      if (config.command !== 'build' || config.mode !== 'production') return
      if (!config.env.VITE_API_URL) {
        throw new Error(
          'VITE_API_URL is not set for this production build — the site would call http://localhost:4000. ' +
          'Set it in .env.production (vercel pull) or the build environment.')
      }
    },
  }
}
