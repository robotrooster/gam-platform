import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sharedAlias } from '../../packages/shared/viteSharedAlias.mjs'
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: sharedAlias
  },
})
