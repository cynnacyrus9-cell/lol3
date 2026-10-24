import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

// wrangler.jsonc points static assets at dist/client; tests do not need a build.
mkdirSync(path.join(import.meta.dirname, 'dist/client'), { recursive: true })

const TEST_SECRETS = {
  INGEST_SECRET: 'test-ingest-secret-0123456789abcdef',
  DASHBOARD_PASSWORD: 'correct horse battery staple',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
  AUTH_MODE: 'password',
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))
  const project = (name: string, include: string, vars: Record<string, string>) => ({
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, ...TEST_SECRETS, ...vars },
        },
      }),
    ],
    test: {
      name,
      include: [include],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  })
  return {
    test: {
      projects: [
        project('worker', 'test/worker/**/*.test.ts', { APP_MODE: 'production' }),
        project('worker-dev', 'test/worker-dev/**/*.test.ts', { APP_MODE: 'development' }),
      ],
    },
  }
})
