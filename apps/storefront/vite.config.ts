import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// S544: guest-facing storefront — one deployment serves every
// property via subdomain ({booking_slug}.gam.biz in prod; path-based
// /:slug in dev). host:true = dual-stack bind (S540 rule).
// S574: allowedHosts includes '.gam.biz' (leading dot = the apex + every
// subdomain) so the Cloudflare tunnel can front '{slug}.gam.biz' → this server.
// Without it Vite rejects the unknown Host header with a 403. localhost is
// allowed by default for dev.
export default defineConfig({
  plugins: [react()],
  server: { host: true, strictPort: true, port: 3015, allowedHosts: ['.gam.biz'] },
})
