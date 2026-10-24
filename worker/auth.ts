import { authMode, type Env } from './env'
import { base64UrlDecode, base64UrlEncode, hmacSha256B64, timingSafeEqual } from './crypto'

export type AuthResult = { ok: true; identity: string } | { ok: false; status: number; reason: string }

export const SESSION_COOKIE = 'rl_session'
const SESSION_TTL_MS = 7 * 24 * 3600_000

// ---------------------------------------------------------------------------
// Cloudflare Access (preferred). Access sits in front of the Worker and injects a
// signed JWT; we still verify it here so a misconfigured Access policy or a
// direct request to the workers.dev hostname cannot bypass authentication.
// ---------------------------------------------------------------------------

interface Jwk {
  kid: string
  kty: string
  n: string
  e: string
  alg?: string
}

let jwksCache: { domain: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null

async function accessKeys(teamDomain: string, forceRefresh = false): Promise<Map<string, CryptoKey>> {
  if (!forceRefresh && jwksCache && jwksCache.domain === teamDomain && Date.now() - jwksCache.fetchedAt < 10 * 60_000) {
    return jwksCache.keys
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new Error(`Access certs request failed: ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = new Map<string, CryptoKey>()
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA') continue
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    keys.set(jwk.kid, key)
  }
  jwksCache = { domain: teamDomain, keys, fetchedAt: Date.now() }
  return keys
}

export async function verifyAccessJwt(token: string, env: Env, now = Date.now()): Promise<AuthResult> {
  const team = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN)
  const aud = env.ACCESS_AUD?.trim()
  if (!team || !aud) return { ok: false, status: 503, reason: 'Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD).' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, status: 401, reason: 'Malformed Access token' }
  let header: { kid?: string; alg?: string }
  let payload: { aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string; sub?: string }
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])))
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])))
  } catch {
    return { ok: false, status: 401, reason: 'Malformed Access token' }
  }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, status: 401, reason: 'Unsupported Access token' }
  let keys = await accessKeys(team)
  let key = keys.get(header.kid)
  if (!key) {
    keys = await accessKeys(team, true)
    key = keys.get(header.kid)
  }
  if (!key) return { ok: false, status: 401, reason: 'Unknown Access signing key' }
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  )
  if (!valid) return { ok: false, status: 401, reason: 'Invalid Access token signature' }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.includes(aud)) return { ok: false, status: 403, reason: 'Access token audience mismatch' }
  const nowSec = Math.floor(now / 1000)
  if (typeof payload.exp !== 'number' || payload.exp < nowSec - 30) return { ok: false, status: 401, reason: 'Access token expired' }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 30) return { ok: false, status: 401, reason: 'Access token not yet valid' }
  if (payload.iss && payload.iss !== `https://${team}`) return { ok: false, status: 401, reason: 'Access token issuer mismatch' }
  const allowed = (env.ACCESS_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const email = payload.email?.toLowerCase() ?? ''
  if (allowed.length > 0 && !allowed.includes(email)) return { ok: false, status: 403, reason: 'This account is not allowed' }
  return { ok: true, identity: email || payload.sub || 'access-user' }
}

function normalizeTeamDomain(v: string | undefined): string | null {
  if (!v) return null
  return v.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') || null
}

// ---------------------------------------------------------------------------
// Password mode (fallback when Access is not available, e.g. plain workers.dev).
// The password is a Wrangler secret; the session cookie is an HMAC-signed token.
// ---------------------------------------------------------------------------

export function passwordModeReady(env: Env): string | null {
  if (!env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD.length < 12) return 'DASHBOARD_PASSWORD secret is missing or shorter than 12 characters.'
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return 'SESSION_SECRET secret is missing or shorter than 32 characters.'
  return null
}

export async function createSessionCookie(env: Env, now = Date.now()): Promise<string> {
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ iat: now, exp: now + SESSION_TTL_MS, sid: crypto.randomUUID() })),
  )
  const sig = await hmacSha256B64(env.SESSION_SECRET!, `session.${payload}`)
  return `${SESSION_COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

export async function verifySessionCookie(value: string, env: Env, now = Date.now()): Promise<AuthResult> {
  const [payload, sig] = value.split('.')
  if (!payload || !sig) return { ok: false, status: 401, reason: 'Invalid session' }
  const expected = await hmacSha256B64(env.SESSION_SECRET!, `session.${payload}`)
  if (!(await timingSafeEqual(sig, expected))) return { ok: false, status: 401, reason: 'Invalid session' }
  try {
    const data = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { exp: number; sid: string }
    if (typeof data.exp !== 'number' || data.exp < now) return { ok: false, status: 401, reason: 'Session expired' }
    return { ok: true, identity: `password:${data.sid.slice(0, 8)}` }
  } catch {
    return { ok: false, status: 401, reason: 'Invalid session' }
  }
}

export async function checkPassword(candidate: string, env: Env): Promise<boolean> {
  if (!env.DASHBOARD_PASSWORD) return false
  return timingSafeEqual(candidate, env.DASHBOARD_PASSWORD)
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return null
}

export async function authenticateDashboard(request: Request, env: Env): Promise<AuthResult> {
  const mode = authMode(env)
  if (mode === 'none') return { ok: true, identity: 'development' }
  if (mode === 'access') {
    const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? getCookie(request, 'CF_Authorization')
    if (!token) return { ok: false, status: 401, reason: 'Sign in through Cloudflare Access' }
    try {
      return await verifyAccessJwt(token, env)
    } catch (err) {
      return { ok: false, status: 503, reason: `Could not verify Access token: ${(err as Error).message}` }
    }
  }
  const notReady = passwordModeReady(env)
  if (notReady) return { ok: false, status: 503, reason: notReady }
  const cookie = getCookie(request, SESSION_COOKIE)
  if (!cookie) return { ok: false, status: 401, reason: 'Not signed in' }
  return verifySessionCookie(cookie, env)
}
