import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// `npm run dev:client` serves the dashboard with hot reload and proxies the
// API to `wrangler dev` (default http://localhost:8787).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src'), '@shared': path.resolve(import.meta.dirname, 'shared') } },
  build: { outDir: 'dist/client', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true, changeOrigin: false },
      '/auth': { target: 'http://localhost:8787' },
      '/ingest': { target: 'http://localhost:8787' },
    },
  },
})
