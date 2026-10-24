import { exports } from 'cloudflare:workers'
import type { IngestBatch, IngestEvent, IngestPlayer } from '../shared/types'

export const ORIGIN = 'https://dash.example.com'
export const INGEST_SECRET = 'test-ingest-secret-0123456789abcdef'
export const PASSWORD = 'correct horse battery staple'

type Fetcher = { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }
export const worker = (exports as unknown as { default: Fetcher }).default

let counter = 0
export function uid(): number {
  counter += 1
  return 100_000 + Math.floor(Math.random() * 1_000_000) * 100 + counter
}
export function jobId(): string {
  return `job-${crypto.randomUUID()}`
}

export function batch(
  job: string,
  opts: { events?: IngestEvent[]; players?: IngestPlayer[]; studio?: boolean; synthetic?: boolean; universeId?: number; sentAt?: number } = {},
): IngestBatch {
  return {
    v: 1,
    batchId: crypto.randomUUID(),
    sentAt: opts.sentAt ?? Date.now(),
    server: { jobId: job, placeId: 111, universeId: opts.universeId, studio: opts.studio, startedAt: Date.now() - 1000 },
    players: opts.players,
    events: opts.events ?? [],
    synthetic: opts.synthetic,
  }
}

export async function ingest(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(`${ORIGIN}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_SECRET}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

export async function ingestOk(body: IngestBatch): Promise<Record<string, unknown>> {
  const res = await ingest(body)
  const data = (await res.json()) as Record<string, unknown>
  if (res.status !== 200) throw new Error(`ingest failed ${res.status}: ${JSON.stringify(data)}`)
  return data
}

let cookie: string | null = null
export async function login(): Promise<string> {
  if (cookie) return cookie
  const res = await worker.fetch(`${ORIGIN}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'cf-connecting-ip': '10.0.0.1' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`)
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  return cookie
}

export async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const c = await login()
  const res = await worker.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { cookie: c, origin: ORIGIN, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // CSV or plain text
  }
  return { status: res.status, body: body as T }
}

export async function live(): Promise<import('../shared/types').LiveSnapshot> {
  const r = await api<{ live: import('../shared/types').LiveSnapshot }>('/api/bootstrap')
  if (r.status !== 200) throw new Error(`bootstrap ${r.status}: ${JSON.stringify(r.body)}`)
  return r.body.live
}

export async function db(): Promise<D1Database> {
  const { env } = await import('cloudflare:workers')
  return (env as unknown as { DB: D1Database }).DB
}

export async function hubStub(): Promise<DurableObjectStub> {
  const { env } = await import('cloudflare:workers')
  const ns = (env as unknown as { HUB: DurableObjectNamespace }).HUB
  return ns.get(ns.idFromName('roadster-life'))
}
