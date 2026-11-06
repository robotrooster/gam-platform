import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sharedAlias } from '../../packages/shared/viteSharedAlias.mjs'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: sharedAlias
  },
  // GAM_API_PROXY (opt-in, unset in normal dev): serve the API under the page's
  // OWN origin so a phone on the LAN can use this server. The API sends no
  // Access-Control-Allow-Origin for an ad-hoc LAN origin, so a cross-origin
  // call is thrown away by the browser and the portal reports "Login failed" —
  // proxying removes the cross-origin call instead of loosening the API's CORS.
  server: {
    host: true, strictPort: true, port: 3002,
    ...(process.env.GAM_API_PROXY
      ? { proxy: { '/api': { target: process.env.GAM_API_PROXY, changeOrigin: true } } }
      : {}),
  }
})
