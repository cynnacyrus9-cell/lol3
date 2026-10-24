import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Design preview with in-browser sample data (no backend). Not deployed with the Worker.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src'), '@shared': path.resolve(import.meta.dirname, 'shared') } },
  build: { outDir: 'dist/preview', emptyOutDir: true, assetsInlineLimit: 100_000_000, rollupOptions: { input: 'preview.html' } },
})
