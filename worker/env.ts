export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  HUB: DurableObjectNamespace

  // ---- plain vars (wrangler.jsonc "vars") ----
  APP_MODE?: string // 'production' | 'development'
  AUTH_MODE?: string // 'access' | 'password' | 'none' (none only allowed in development)
  GAME_NAME?: string
  REPORTING_TIMEZONE?: string
  ROBLOX_UNIVERSE_ID?: string
  ROBLOX_PLACE_ID?: string
  ROBLOX_GROUP_ID?: string
  ACCESS_TEAM_DOMAIN?: string // e.g. myteam.cloudflareaccess.com
  ACCESS_AUD?: string // Access application audience tag
  ACCESS_ALLOWED_EMAILS?: string // optional comma separated allow-list
  CF_ACCOUNT_ID?: string // enables the GraphQL usage panel together with CF_API_TOKEN
  INGEST_REQUIRE_HMAC?: string // 'true' to reject bearer-only ingestion
  OFFICIAL_POLL_SEC?: string
  ALLOWED_ORIGINS?: string // extra dashboard origins for WebSocket Origin checks (comma separated)

  // ---- secrets (wrangler secret put) ----
  INGEST_SECRET?: string
  ROBLOX_OPEN_CLOUD_API_KEY?: string
  DASHBOARD_PASSWORD?: string
  SESSION_SECRET?: string
  CF_API_TOKEN?: string
}

export type AppMode = 'production' | 'development'

export function appMode(env: Env): AppMode {
  return env.APP_MODE === 'development' ? 'development' : 'production'
}

export type AuthMode = 'access' | 'password' | 'none'

export function authMode(env: Env): AuthMode {
  const m = (env.AUTH_MODE ?? 'access').toLowerCase()
  if (m === 'password') return 'password'
  if (m === 'none') return appMode(env) === 'development' ? 'none' : 'access'
  return 'access'
}

export const SECRET_NAMES = [
  'INGEST_SECRET',
  'ROBLOX_OPEN_CLOUD_API_KEY',
  'DASHBOARD_PASSWORD',
  'SESSION_SECRET',
  'CF_API_TOKEN',
] as const

export function secretStatus(env: Env): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const k of SECRET_NAMES) out[k] = typeof env[k] === 'string' && (env[k] as string).length > 0
  return out
}
