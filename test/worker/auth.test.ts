import { describe, expect, it } from 'vitest'
import { hmacSha256Hex } from '../../worker/crypto'
import { verifyAccessJwt } from '../../worker/auth'
import { base64UrlEncode } from '../../worker/crypto'
import { batch, ingest, INGEST_SECRET, jobId, ORIGIN, uid, worker } from '../helpers'

describe('dashboard authentication', () => {
  it('rejects API calls without a session', async () => {
    const res = await worker.fetch(`${ORIGIN}/api/bootstrap`)
    expect(res.status).toBe(401)
    const ws = await worker.fetch(`${ORIGIN}/api/live`, { headers: { upgrade: 'websocket', origin: ORIGIN } })
    expect(ws.status).toBe(401)
  })

  it('rejects a forged session cookie', async () => {
    const res = await worker.fetch(`${ORIGIN}/api/bootstrap`, { headers: { cookie: 'rl_session=eyJleHAiOjk5OTk5OTk5OTk5OTl9.forged' } })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong password and rate-limits brute force attempts', async () => {
    const attempt = () =>
      worker.fetch(`${ORIGIN}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' },
        body: JSON.stringify({ password: 'nope' }),
      })
    const first = await attempt()
    expect(first.status).toBe(401)
    let limited = false
    for (let i = 0; i < 8; i++) if ((await attempt()).status === 429) limited = true
    expect(limited).toBe(true)
  })

  it('rejects cross-origin login and state-changing API requests', async () => {
    const res = await worker.fetch(`${ORIGIN}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ password: 'x' }),
    })
    expect(res.status).toBe(403)
  })

  it('issues a working HttpOnly session cookie for the right password', async () => {
    const res = await worker.fetch(`${ORIGIN}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '198.51.100.7' },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/HttpOnly/)
    expect(setCookie).toMatch(/SameSite=Strict/)
    const cookie = setCookie.split(';')[0]
    const ok = await worker.fetch(`${ORIGIN}/api/bootstrap`, { headers: { cookie } })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { config: { secrets: Record<string, boolean> } }
    // Only presence flags are exposed, never secret values.
    expect(JSON.stringify(body)).not.toContain(INGEST_SECRET)
    expect(body.config.secrets.INGEST_SECRET).toBe(true)
    const evil = await worker.fetch(`${ORIGIN}/api/admin/config`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ dailyGoalRobux: 5 }),
    })
    expect(evil.status).toBe(403)
  })
})

describe('Roblox server authentication', () => {
  const body = () => JSON.stringify(batch(jobId(), { events: [{ type: 'join', u: uid(), j: Date.now() }] }))

  it('rejects missing and wrong bearer secrets', async () => {
    expect((await ingest(body(), { authorization: '' })).status).toBe(401)
    expect((await ingest(body(), { authorization: 'Bearer wrong-secret' })).status).toBe(401)
  })

  it('accepts a valid HMAC signature and rejects tampering and stale timestamps', async () => {
    const b = body()
    const ts = Date.now()
    const sig = await hmacSha256Hex(INGEST_SECRET, `${ts}.${b}`)
    const ok = await ingest(b, { authorization: '', 'x-rl-timestamp': String(ts), 'x-rl-signature': `v1=${sig}` })
    expect(ok.status).toBe(200)
    const tampered = b.replace('"join"', '"leave"')
    const bad = await ingest(tampered, { authorization: '', 'x-rl-timestamp': String(ts), 'x-rl-signature': `v1=${sig}` })
    expect(bad.status).toBe(401)
    const old = ts - 10 * 60_000
    const oldSig = await hmacSha256Hex(INGEST_SECRET, `${old}.${b}`)
    const stale = await ingest(b, { authorization: '', 'x-rl-timestamp': String(old), 'x-rl-signature': `v1=${oldSig}` })
    expect(stale.status).toBe(401)
  })

  it('rejects replayed payloads whose sentAt is outside the clock window', async () => {
    const res = await ingest(batch(jobId(), { sentAt: Date.now() - 10 * 60_000 }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/clock window/)
  })
})

describe('Cloudflare Access JWT verification', () => {
  async function setup() {
    const keys = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey
    const kid = `kid-${crypto.randomUUID()}`
    const team = `team-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === `https://${team}/cdn-cgi/access/certs`) return Response.json({ keys: [{ ...jwk, kid }] })
      return realFetch(input as RequestInfo)
    }) as typeof fetch
    const sign = async (payload: Record<string, unknown>) => {
      const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)))
      const head = enc({ alg: 'RS256', kid })
      const body = enc(payload)
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`)))
      return `${head}.${body}.${base64UrlEncode(sig)}`
    }
    return { team, sign, restore: () => (globalThis.fetch = realFetch) }
  }

  it('accepts a valid token and enforces audience, expiry and the email allow-list', async () => {
    const { team, sign, restore } = await setup()
    try {
      const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'aud-123', ACCESS_ALLOWED_EMAILS: 'owner@example.com' } as never
      const exp = Math.floor(Date.now() / 1000) + 600
      const good = await verifyAccessJwt(await sign({ aud: ['aud-123'], exp, email: 'owner@example.com', iss: `https://${team}` }), env)
      expect(good.ok).toBe(true)
      const wrongAud = await verifyAccessJwt(await sign({ aud: ['other'], exp, email: 'owner@example.com' }), env)
      expect(wrongAud).toMatchObject({ ok: false, status: 403 })
      const expired = await verifyAccessJwt(await sign({ aud: ['aud-123'], exp: 1000, email: 'owner@example.com' }), env)
      expect(expired).toMatchObject({ ok: false, status: 401 })
      const stranger = await verifyAccessJwt(await sign({ aud: ['aud-123'], exp, email: 'someone@example.com' }), env)
      expect(stranger).toMatchObject({ ok: false, status: 403 })
      const forged = (await sign({ aud: ['aud-123'], exp, email: 'owner@example.com' })).replace(/\.[^.]+$/, '.AAAA')
      expect((await verifyAccessJwt(forged, env)).ok).toBe(false)
    } finally {
      restore()
    }
  })
})
