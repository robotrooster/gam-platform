import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// S544: guest-facing storefront — one deployment serves every
// property via subdomain ({booking_slug}.gam.biz in prod; path-based
// /:slug in dev). host:true = dual-stack bind (S540 rule).
export default defineConfig({
  plugins: [react()],
  server: { host: true, strictPort: true, port: 3015 },
})
