import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src'), '@shared': path.resolve(import.meta.dirname, 'shared') } },
  test: { name: 'client', include: ['test/client/**/*.test.ts'], environment: 'node' },
})
