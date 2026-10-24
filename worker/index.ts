import { authenticateDashboard, clearSessionCookie } from './auth'
import { authMode, appMode, type Env } from './env'
import { hmacSha256Hex, timingSafeEqual } from './crypto'
import { MAX_BODY_BYTES, CLOCK_SKEW_MS } from './validate'

export { AnalyticsHub } from './hub'

const HUB_NAME = 'roadster-life'

function hub(env: Env): DurableObjectStub {
  return env.HUB.get(env.HUB.idFromName(HUB_NAME))
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

function withSecurity(res: Response): Response {
  if (res.status === 101) return res
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v)
  return out
}

async function forward(env: Env, request: Request, kind: string, extra: Record<string, string> = {}): Promise<Response> {
  const headers = new Headers(request.headers)
  headers.set('x-rl-kind', kind)
  for (const [k, v] of Object.entries(extra)) headers.set(k, v)
  // Never pass browser credentials further than needed.
  headers.delete('cookie')
  headers.delete('cf-access-jwt-assertion')
  headers.delete('authorization')
  try {
    return await hub(env).fetch(new Request(request.url, { method: request.method, headers, body: request.body }))
  } catch (err) {
    console.error('hub unavailable', err)
    return json({ ok: false, error: `Backend unavailable: ${(err as Error).message}. If this is a new deployment, run the D1 migrations.` }, 503)
  }
}

/** Same-origin check for state-changing requests and WebSocket upgrades (CSRF / CSWSH). */
function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return false
  const self = new URL(request.url).origin
  if (origin === self) return true
  const extra = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (extra.includes(origin)) return true
  // Local development with the Vite dev server proxying to wrangler.
  return appMode(env) === 'development' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

/**
 * Authenticates a Roblox game server.
 *   - HMAC mode: X-RL-Timestamp + X-RL-Signature = hex(HMAC-SHA256(secret, `${ts}.${body}`))
 *   - Bearer mode: Authorization: Bearer <INGEST_SECRET> (works with Roblox Secrets store,
 *     whose values cannot be read by scripts and therefore cannot sign).
 * Both modes also require a fresh `sentAt` and unique `batchId` inside the body
 * (checked by the hub) for replay protection.
 */
export async function verifyIngest(request: Request, body: string, env: Env, now = Date.now()): Promise<string | null> {
  const secret = env.INGEST_SECRET
  if (!secret || secret.length < 24) return 'INGEST_SECRET is not configured on the backend'
  const sig = request.headers.get('X-RL-Signature')
  if (sig) {
    const ts = Number(request.headers.get('X-RL-Timestamp'))
    if (!Number.isFinite(ts) || Math.abs(now - ts) > CLOCK_SKEW_MS) return 'Signature timestamp outside the allowed window'
    const expected = await hmacSha256Hex(secret, `${ts}.${body}`)
    return (await timingSafeEqual(sig.replace(/^v1=/, '').toLowerCase(), expected)) ? null : 'Invalid signature'
  }
  if (env.INGEST_REQUIRE_HMAC === 'true') return 'This backend requires HMAC-signed requests'
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return 'Missing credentials'
  return (await timingSafeEqual(token, secret)) ? null : 'Invalid credentials'
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  const len = Number(request.headers.get('content-length') ?? '0')
  if (len > MAX_BODY_BYTES) return json({ ok: false, error: 'Payload too large' }, 413)
  const body = await request.text()
  if (body.length > MAX_BODY_BYTES) return json({ ok: false, error: 'Payload too large' }, 413)
  const authError = await verifyIngest(request, body, env)
  if (authError) return json({ ok: false, error: authError }, 401)
  return forward(env, new Request(request.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), 'ingest')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/ingest') return withSecurity(await handleIngest(request, env))

    if (path === '/auth/session' && request.method === 'GET') {
      const auth = await authenticateDashboard(request, env)
      return withSecurity(json({ authenticated: auth.ok, mode: authMode(env), reason: auth.ok ? null : auth.reason }, 200))
    }
    if (path === '/auth/login' && request.method === 'POST') {
      if (!originAllowed(request, env)) return withSecurity(json({ ok: false, error: 'Cross-origin request rejected' }, 403))
      return withSecurity(await forward(env, request, 'login', { 'x-rl-ip': request.headers.get('CF-Connecting-IP') ?? 'unknown' }))
    }
    if (path === '/auth/logout' && request.method === 'POST') {
      if (!originAllowed(request, env)) return withSecurity(json({ ok: false, error: 'Cross-origin request rejected' }, 403))
      return withSecurity(json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() }))
    }

    if (path.startsWith('/api/')) {
      const auth = await authenticateDashboard(request, env)
      if (!auth.ok) return withSecurity(json({ ok: false, error: auth.reason, auth: authMode(env) }, auth.status))
      const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
      if (isWs || request.method !== 'GET') {
        if (!originAllowed(request, env)) return withSecurity(json({ ok: false, error: 'Cross-origin request rejected' }, 403))
      }
      if (request.method !== 'GET' && request.method !== 'POST') return withSecurity(json({ ok: false, error: 'Method not allowed' }, 405))
      if (request.method === 'POST' && !(request.headers.get('content-type') ?? '').includes('application/json')) {
        return withSecurity(json({ ok: false, error: 'Expected application/json' }, 415))
      }
      return withSecurity(await forward(env, request, isWs ? 'ws' : 'api'))
    }

    return env.ASSETS.fetch(request)
  },

  /** Watchdog: keeps the hub's alarm loop armed (e.g. right after a deploy). */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(forward(env, new Request('https://hub.internal/internal/cron', { method: 'POST' }), 'cron').then(() => undefined))
  },
} satisfies ExportedHandler<Env>
