// Browser-only sample-data backend for the design preview (preview.html).
// It answers the dashboard's API calls and fakes the live WebSocket so the UI
// can be explored without a deployed Worker. Never used by the real dashboard.
import type { ActivityEvent, LiveSnapshot, PublicConfig, ServerMessage } from '@shared/types'
import { dayKey, dayRangeUtc, dayStartUtc, hourBucketStart, listDays, resolveRange, type RangePreset } from '@shared/time'

const TZ = 'America/Los_Angeles'
const MIN = 60_000
const HISTORY_DAYS = 30

let seed = 20261024
function rand() {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const PRODUCTS = [
  { kind: 'developer_product' as const, productId: 1001, name: 'Nitro Boost', price: 49, w: 30 },
  { kind: 'developer_product' as const, productId: 1002, name: 'Cash Pack (Small)', price: 99, w: 22 },
  { kind: 'developer_product' as const, productId: 1003, name: 'Cash Pack (Large)', price: 249, w: 9 },
  { kind: 'developer_product' as const, productId: 1004, name: 'Custom Paint', price: 25, w: 25 },
  { kind: 'developer_product' as const, productId: 1005, name: 'Instant Repair', price: 15, w: 18 },
  { kind: 'game_pass' as const, productId: 2001, name: 'VIP Garage', price: 399, w: 3 },
  { kind: 'game_pass' as const, productId: 2002, name: 'Drift Kit', price: 149, w: 4 },
  { kind: 'game_pass' as const, productId: 2003, name: '2x Cash', price: 199, w: 3 },
]
const NAME_A = ['Turbo', 'Drift', 'Nitro', 'Road', 'Gear', 'Piston', 'Chrome', 'Rally', 'Speedy', 'Midnight', 'Neon', 'Clutch']
const NAME_B = ['Kai', 'Racer', 'Fox', 'Ace', 'Blaze', 'Zoe', 'Max', 'Rex', 'Luna', 'Jett', 'Nova', 'Milo']
const users = Array.from({ length: 2500 }, (_, i) => ({ id: 1_200_000_000 + i * 7919, name: `${NAME_A[i % 12]}${NAME_B[Math.floor(i / 12) % 12]}${i % 97}` }))

function pickProduct() {
  const total = PRODUCTS.reduce((a, p) => a + p.w, 0)
  let r = rand() * total
  for (const p of PRODUCTS) if ((r -= p.w) <= 0) return p
  return PRODUCTS[0]
}

// Daily shape: quiet early morning, peak around 7 PM Pacific.
function pattern(t: number) {
  const d = new Date(t)
  const h = (d.getUTCHours() - 7 + 24) % 24 + d.getUTCMinutes() / 60
  return 0.32 + 0.68 * Math.pow(Math.max(0, Math.sin(((h - 7) / 24) * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5), 1.4)
}

const now0 = Date.now()
const start = Math.floor((now0 - HISTORY_DAYS * 86_400_000) / MIN) * MIN
const minutes: { t: number; ccu: number; joins: number }[] = []
let walk = 0
for (let t = start; t <= now0; t += MIN) {
  walk = walk * 0.97 + (rand() - 0.5) * 3
  const ccu = Math.max(0, Math.round(64 * pattern(t) + walk))
  minutes.push({ t, ccu, joins: ccu * 0.085 * (0.7 + rand() * 0.6) })
}

interface Sale {
  key: string
  kind: 'developer_product' | 'game_pass'
  productId: number
  productName: string
  robux: number
  user: (typeof users)[number]
  at: number
}
const sales: Sale[] = []
for (const m of minutes) {
  if (rand() < m.ccu * 0.0042) {
    const p = pickProduct()
    sales.push({ key: `dp:${sales.length}`, kind: p.kind, productId: p.productId, productName: p.name, robux: p.price, user: users[Math.floor(Math.pow(rand(), 2.2) * users.length)], at: m.t + Math.floor(rand() * MIN) })
  }
}

const V0 = 1_412_000
let officialVisits = V0
const officialAt: { t: number; v: number }[] = []
for (const m of minutes) {
  officialVisits += m.joins * 1.03
  if ((m.t / MIN) % 5 === 0) officialAt.push({ t: m.t, v: Math.round(officialVisits) })
}
function officialValueAt(t: number): number | null {
  let lo = 0
  let hi = officialAt.length - 1
  if (t < officialAt[0].t) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (officialAt[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return officialAt[lo].v
}

// ---------------------------------------------------------------- live state
const servers = new Map<string, { players: number; startedAt: number; lastSeenAt: number }>()
for (let i = 0; i < 4; i++) servers.set(crypto.randomUUID(), { players: 0, startedAt: now0 - (1 + i * 2) * 3_600_000, lastSeenAt: now0 })
let ccu = minutes[minutes.length - 1].ccu
function spreadPlayers() {
  const ids = [...servers.keys()]
  let left = ccu
  ids.forEach((id, i) => {
    const n = i === ids.length - 1 ? left : Math.min(left, Math.round(ccu / ids.length + (rand() - 0.5) * 6))
    servers.get(id)!.players = Math.max(0, n)
    left -= Math.max(0, n)
  })
}
spreadPlayers()
let seq = 900
let liveVisits = Math.round(officialVisits)
let officialFetchedAt = now0
let officialChangedAt = now0
let joinsSinceUpdate = 0
const events: ActivityEvent[] = []
function pushEvent(e: Omit<ActivityEvent, 'seq' | 'category' | 'source'>, category: ActivityEvent['category']) {
  const ev: ActivityEvent = { ...e, seq: ++seq, category, source: 'live' }
  events.unshift(ev)
  if (events.length > 400) events.length = 400
  return ev
}
for (const s of sales.slice(-25)) pushEvent({ type: 'purchase', at: s.at, data: saleData(s) }, 'sales')
events.sort((a, b) => b.seq - a.seq)

function saleData(s: Sale) {
  return { dedupeKey: s.key, kind: s.kind, productId: s.productId, productName: s.productName, robux: s.robux, amountSource: s.kind === 'game_pass' ? 'list_price' : 'receipt', userId: s.user.id, username: s.user.name, purchasedAt: s.at, receivedAt: s.at, source: 'live' }
}

function totals(startMs: number, endMs: number) {
  let revenue = 0, sales_ = 0, dpR = 0, dpS = 0, gpR = 0, gpS = 0
  const buyers = new Set<number>()
  for (const s of sales) {
    if (s.at < startMs || s.at >= endMs) continue
    revenue += s.robux
    sales_++
    buyers.add(s.user.id)
    if (s.kind === 'game_pass') { gpR += s.robux; gpS++ } else { dpR += s.robux; dpS++ }
  }
  let joins = 0, ccuSum = 0, peak = 0, mins = 0
  for (const m of minutes) {
    if (m.t < startMs || m.t >= endMs) continue
    joins += m.joins
    ccuSum += m.ccu
    peak = Math.max(peak, m.ccu)
    mins++
  }
  const a = officialValueAt(startMs)
  const b = officialValueAt(endMs)
  const visits = Math.round(joins)
  return {
    revenue, sales: sales_, devProductRevenue: dpR, devProductSales: dpS, gamePassRevenue: gpR, gamePassSales: gpS,
    trackedVisits: visits, uniquePlayers: Math.round(visits * 0.71), payingPlayers: buyers.size, peakCcu: peak,
    avgCcu: mins ? ccuSum / mins : null, trackedMinutes: mins, sessionsEnded: visits, sessionSecondsTotal: visits * 742,
    avgSessionSec: visits ? 742 : null, officialNewVisits: a !== null && b !== null ? b - a : null,
  }
}

function today() {
  const now = Date.now()
  const day = dayKey(now, TZ)
  const t = totals(dayStartUtc(day, TZ), now)
  const peakM = minutes.filter((m) => m.t >= dayStartUtc(day, TZ)).reduce((a, m) => (m.ccu > a.ccu ? m : a), { t: now, ccu: 0, joins: 0 })
  return { ...t, dayKey: day, peakAt: peakM.t, firstTrackedAt: start, ccuMinuteSum: 0 }
}

function snapshot(): LiveSnapshot {
  const now = Date.now()
  const t = today()
  const baseline = officialValueAt(dayStartUtc(t.dayKey, TZ)) ?? liveVisits
  const hourAgo = officialValueAt(now - 3_600_000)
  const dayAgo = officialValueAt(now - 86_400_000)
  const q = officialValueAt(now - 15 * MIN)
  const all = sales.reduce((a, s) => a + s.robux, 0)
  return {
    serverTime: now, seq, mode: 'production', tz: TZ, ccu, activeServers: servers.size,
    servers: [...servers.entries()].map(([jobId, s]) => ({ jobId, placeId: 1234567, players: s.players, startedAt: s.startedAt, lastSeenAt: s.lastSeenAt, heartbeatSec: 60, source: 'live', privateServer: false })),
    joinsLast5m: Math.round(minutes.slice(-5).reduce((a, m) => a + m.joins, 0)),
    leavesLast5m: Math.round(minutes.slice(-5).reduce((a, m) => a + m.joins, 0) * 0.97),
    joinRatePerMin: minutes.slice(-5).reduce((a, m) => a + m.joins, 0) / 5,
    today: { ...t, avgCcu: t.avgCcu, avgSessionSec: t.avgSessionSec },
    allTime: { revenue: all, sales: sales.length, since: sales[0]?.at ?? null },
    official: {
      status: 'delayed', visits: liveVisits, playing: ccu + 2, favorites: 18_420, name: 'Roadster Life', rootPlaceId: 1234567,
      fetchedAt: officialFetchedAt, changedAt: officialChangedAt, lastError: null, nextPollAt: officialFetchedAt + 30_000, pollSec: 30,
      visitsToday: liveVisits - baseline, visitsTodayBaselineAt: dayStartUtc(t.dayKey, TZ),
      visitsLastHour: hourAgo === null ? null : liveVisits - hourAgo, visitsLastDay: dayAgo === null ? null : liveVisits - dayAgo,
      visitsPerMinute: q === null ? null : (liveVisits - q) / 15, upVotes: 9_310, downVotes: 1_204, trackedJoinsSinceUpdate: joinsSinceUpdate,
    },
    ingest: { status: 'live', lastEventAt: now - 800, lastPurchaseAt: sales[sales.length - 1]?.at ?? null, lastHeartbeatAt: now - 4_000 },
    budget: { level: 'ok', heartbeatSec: 60, flushSec: 1, joinLeaveLogging: true, snapshotEverySec: 60, messages: [] },
    viewers: 1, dailyGoalRobux: 15_000, netRevenueRate: 0.7,
  }
}

const config: PublicConfig = {
  gameName: 'Roadster Life', universeId: '0', placeId: '1234567', groupId: null, timezone: TZ, dailyGoalRobux: 15_000,
  milestones: [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000], netRevenueRate: 0.7, officialPollSec: 30,
  activityRetentionDays: 30, products: PRODUCTS.map((p) => ({ kind: p.kind, productId: p.productId, name: p.name, priceRobux: p.price })),
  mode: 'production', authMode: 'none',
  secrets: { INGEST_SECRET: true, ROBLOX_OPEN_CLOUD_API_KEY: false, DASHBOARD_PASSWORD: false, SESSION_SECRET: false, CF_API_TOKEN: false },
}

// ---------------------------------------------------------------- live ticking
const sockets = new Set<FakeSocket>()
function broadcast(msg: ServerMessage) {
  const text = JSON.stringify(msg)
  for (const s of sockets) s.deliver(text)
}
setInterval(() => {
  const now = Date.now()
  const target = 64 * pattern(now)
  const prev = ccu
  ccu = Math.max(0, Math.round(ccu + (target - ccu) * 0.05 + (rand() - 0.5) * 3))
  const last = minutes[minutes.length - 1]
  const joins = Math.max(0, ccu - prev) + (rand() < 0.5 ? 1 : 0)
  if (now - last.t >= MIN) minutes.push({ t: Math.floor(now / MIN) * MIN, ccu, joins })
  else { last.ccu = ccu; last.joins += joins }
  joinsSinceUpdate += joins
  spreadPlayers()
  for (const s of servers.values()) s.lastSeenAt = now - Math.floor(rand() * 20_000)
  for (let i = 0; i < joins; i++) {
    const u = users[Math.floor(rand() * users.length)]
    broadcast({ t: 'event', event: pushEvent({ type: 'player_join', at: now, data: { userId: u.id, username: u.name, jobId: [...servers.keys()][i % servers.size] } }, 'players') })
  }
  if (ccu < prev) {
    const u = users[Math.floor(rand() * users.length)]
    broadcast({ t: 'event', event: pushEvent({ type: 'player_leave', at: now, data: { userId: u.id, username: u.name, sessionSec: 200 + Math.floor(rand() * 1500), reason: 'left' } }, 'players') })
  }
  if (rand() < 0.07) {
    const p = pickProduct()
    const s: Sale = { key: `dp:live-${seq}`, kind: p.kind, productId: p.productId, productName: p.name, robux: p.price, user: users[Math.floor(rand() * users.length)], at: now }
    sales.push(s)
    const ev = pushEvent({ type: 'purchase', at: now, data: saleData(s) }, 'sales')
    broadcast({ t: 'event', event: ev })
    broadcast({ t: 'sale', sale: ev.data as never, seq: ev.seq })
  }
  // The official Roblox counter only moves when "polled" (every 30 s).
  if (now - officialFetchedAt >= 30_000) {
    officialVisits += joinsSinceUpdate * 1.03 + rand() * 4
    liveVisits = Math.round(officialVisits)
    officialAt.push({ t: now, v: liveVisits })
    officialFetchedAt = now
    officialChangedAt = now
    joinsSinceUpdate = 0
  }
  broadcast({ t: 'live', live: snapshot() })
}, 1000)

class FakeSocket {
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = 1
      sockets.add(this)
      this.onopen?.()
      this.deliver(JSON.stringify({ t: 'hello', live: snapshot(), missed: [], gap: false }))
    }, 150)
  }
  deliver(text: string) {
    this.onmessage?.({ data: text })
  }
  send(d: string) {
    if (d === 'ping') setTimeout(() => this.deliver('pong'), 20)
  }
  close() {
    sockets.delete(this)
    this.readyState = 3
    this.onclose?.()
  }
}

// ---------------------------------------------------------------- API
function rangeFrom(q: URLSearchParams) {
  return resolveRange((q.get('range') ?? 'today') as RangePreset, Date.now(), TZ, { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined }, dayKey(start, TZ))
}
function dailyRows(fromDay: string, toDay: string) {
  const today = dayKey(Date.now(), TZ)
  return listDays(fromDay, toDay).filter((d) => d >= dayKey(start, TZ)).map((d) => {
    const [s, e] = dayRangeUtc(d, TZ)
    const t = totals(s, Math.min(e, Date.now()))
    return { day: d, ...t, finalized: d !== today }
  })
}
function summary(q: URLSearchParams) {
  const range = rangeFrom(q)
  const cur = { ...totals(range.startMs, range.endMs), days: 1, daysWithData: 1 }
  const prev = range.prev ? { ...totals(range.prev.startMs, range.prev.endMs), days: 1, daysWithData: range.prev.startMs >= start ? 1 : 0 } : null
  return { range, current: cur, previous: prev, daily: range.preset === 'today' ? [] : dailyRows(range.fromDay, range.toDay), firstTrackedAt: start, netRevenueRate: 0.7, generatedAt: Date.now() }
}
function hourly(startMs: number, endMs: number) {
  const out: number[] = []
  for (let t = hourBucketStart(startMs, TZ); t < endMs; t = hourBucketStart(t + 3_660_000, TZ)) out.push(t)
  return out
}
function api(path: string, q: URLSearchParams): unknown {
  switch (path) {
    case '/auth/session':
      return { authenticated: true, mode: 'none', reason: null }
    case '/api/bootstrap':
      return { config, live: snapshot(), recent: events.slice(0, 50) }
    case '/api/summary':
      return summary(q)
    case '/api/series/ccu': {
      const spans: Record<string, [number, number]> = { '5m': [5 * MIN, MIN], '15m': [15 * MIN, MIN], '1h': [60 * MIN, MIN], '6h': [360 * MIN, 5 * MIN], '24h': [1440 * MIN, 10 * MIN], '7d': [10080 * MIN, 60 * MIN] }
      const [span, bucket] = spans[q.get('window') ?? '1h'] ?? spans['1h']
      const now = Date.now()
      const map = new Map<number, { s: number; n: number; mx: number }>()
      for (const m of minutes) {
        if (m.t < now - span) continue
        const b = Math.floor(m.t / bucket) * bucket
        const c = map.get(b) ?? { s: 0, n: 0, mx: 0 }
        c.s += m.ccu; c.n++; c.mx = Math.max(c.mx, m.ccu)
        map.set(b, c)
      }
      return { window: q.get('window'), bucketMs: bucket, firstTrackedAt: start, live: { t: now, ccu }, points: [...map.entries()].map(([t, c]) => ({ t, ccu: Math.round((c.s / c.n) * 10) / 10, max: c.mx, servers: servers.size, official: null })) }
    }
    case '/api/series/revenue': {
      const range = rangeFrom(q)
      if (range.endMs - range.startMs <= 72 * 3_600_000) {
        return { granularity: 'hour', range, firstTrackedAt: start, buckets: hourly(range.startMs, range.endMs).map((t) => { const x = totals(t, t + 3_600_000); return { t, revenue: x.revenue, sales: x.sales, devProductRevenue: x.devProductRevenue, gamePassRevenue: x.gamePassRevenue } }) }
      }
      return { granularity: 'day', range, firstTrackedAt: start, buckets: dailyRows(range.fromDay, range.toDay).map((d) => ({ t: dayStartUtc(d.day, TZ), day: d.day, revenue: d.revenue, sales: d.sales, devProductRevenue: d.devProductRevenue, gamePassRevenue: d.gamePassRevenue })) }
    }
    case '/api/series/visits': {
      const range = rangeFrom(q)
      if (range.endMs - range.startMs <= 72 * 3_600_000) {
        return { granularity: 'hour', range, firstTrackedAt: start, buckets: hourly(range.startMs, range.endMs).map((t) => { const x = totals(t, t + 3_600_000); return { t, tracked: x.trackedVisits, official: x.officialNewVisits } }) }
      }
      return { granularity: 'day', range, firstTrackedAt: start, buckets: dailyRows(range.fromDay, range.toDay).map((d) => ({ t: dayStartUtc(d.day, TZ), day: d.day, tracked: d.trackedVisits, official: d.officialNewVisits, uniquePlayers: d.uniquePlayers })) }
    }
    case '/api/products': {
      const range = rangeFrom(q)
      const m = new Map<number, { kind: string; productId: number; name: string; revenue: number; sales: number; buyers: Set<number>; lastSoldAt: number }>()
      for (const s of sales) {
        if (s.at < range.startMs || s.at >= range.endMs) continue
        const r = m.get(s.productId) ?? { kind: s.kind, productId: s.productId, name: s.productName, revenue: 0, sales: 0, buyers: new Set(), lastSoldAt: 0 }
        r.revenue += s.robux; r.sales++; r.buyers.add(s.user.id); r.lastSoldAt = Math.max(r.lastSoldAt, s.at)
        m.set(s.productId, r)
      }
      return { range, products: [...m.values()].map((r) => ({ ...r, buyers: r.buyers.size })).sort((a, b) => b.revenue - a.revenue) }
    }
    case '/api/top-spenders': {
      const range = rangeFrom(q)
      const m = new Map<number, { userId: number; username: string; robux: number; purchases: number; lastAt: number; firstAt: number }>()
      for (const s of sales) {
        if (s.at < range.startMs || s.at >= range.endMs) continue
        const r = m.get(s.user.id) ?? { userId: s.user.id, username: s.user.name, robux: 0, purchases: 0, lastAt: 0, firstAt: s.at }
        r.robux += s.robux; r.purchases++; r.lastAt = Math.max(r.lastAt, s.at)
        m.set(s.user.id, r)
      }
      return { range, spenders: [...m.values()].sort((a, b) => b.robux - a.robux).slice(0, 50) }
    }
    case '/api/insights': {
      const days = dailyRows(dayKey(start, TZ), dayKey(Date.now(), TZ))
      const best = days.reduce((a, d) => (d.revenue > a.revenue ? d : a), days[0])
      const prod = (api('/api/products', new URLSearchParams({ range: '30d' })) as { products: { kind: string; productId: number; name: string; sales: number; revenue: number }[] }).products
      return { highestEarningDay: { day: best.day, revenue: best.revenue }, bestSellers: [...prod].sort((a, b) => b.sales - a.sales).slice(0, 5).map((p) => ({ kind: p.kind, product_id: p.productId, name: p.name, sales: p.sales, revenue: p.revenue })), servers7d: { count: 412, avgUptimeSec: 3.4 * 3600, heartbeatTimeouts: 3 } }
    }
    case '/api/activity': {
      const before = Number(q.get('before')) || Infinity
      const cats = (q.get('categories') ?? '').split(',').filter(Boolean)
      const list = events.filter((e) => e.seq < before && (!cats.length || cats.includes(e.category))).slice(0, Number(q.get('limit')) || 50)
      return { events: list, hasMore: false }
    }
    case '/api/admin/usage': {
      const now = Date.now()
      const metric = (key: string, label: string, used: number, limit: number, note: string) => ({ key, label, used, limit, projected: used * 2, pct: used / limit, projectedPct: (used * 2) / limit, note })
      return {
        report: { day: new Date(now).toISOString().slice(0, 10), resetsAt: now + 6 * 3_600_000, metrics: [metric('workerRequests', 'Worker requests', 18_240, 100_000, 'Preview sample'), metric('doRequests', 'Durable Object requests', 19_410, 100_000, 'Preview sample'), metric('d1RowsRead', 'D1 rows read', 312_000, 5_000_000, 'Preview sample'), metric('d1RowsWritten', 'D1 rows written', 21_800, 100_000, 'Preview sample')], counters: { worker: {}, doRequests: { fetch: 0, alarm: 1440 }, wsMessagesIn: 40, doStorage: { reads: 0, writes: 0 }, roblox: { requests: 1440, errors: 0, rateLimited: 0 }, ingest: { batches: 17_000, events: 21_000, duplicates: 3, rejected: 0 } } },
        budget: { level: 'ok', heartbeatSec: 60, flushSec: 1, joinLeaveLogging: true, messages: [] }, cloudflare: null, cloudflareConfigured: false, viewers: 1, liveServers: servers.size,
      }
    }
    case '/api/admin/integration':
      return { servers: [], recentBatches: [], ingestSecretConfigured: true, requireHmac: false, universeId: '0' }
  }
  return null
}

export function installPreviewBackend() {
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) return realFetch(input, init)
    await new Promise((r) => setTimeout(r, 120))
    if ((init?.method ?? 'GET') !== 'GET') return Response.json({ ok: false, error: 'This is a design preview with sample data. Deploy the real dashboard to change settings.' }, { status: 400 })
    const body = api(url.pathname, url.searchParams)
    return body === null ? Response.json({ ok: false, error: 'Not available in the preview' }, { status: 404 }) : Response.json(body)
  }
  ;(window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
}
