import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sharedAlias } from '../../packages/shared/viteSharedAlias.mjs'
import { requireApiUrl } from '../../packages/shared/viteRequireApiUrl.mjs'

export default defineConfig({
  plugins: [react(), requireApiUrl()],
  resolve: {
    alias: sharedAlias
  },
  server: { host: true, strictPort: true, port: 3006 },
})
