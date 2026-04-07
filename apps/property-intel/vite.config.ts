import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  server: { strictPort: true, port: 3007, host: '127.0.0.1' },
})
