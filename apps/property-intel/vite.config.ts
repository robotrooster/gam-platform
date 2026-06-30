import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sharedAlias } from '../../packages/shared/viteSharedAlias.mjs'
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: sharedAlias
  },
  server: { strictPort: true, port: 3007, host: '127.0.0.1' },
})
