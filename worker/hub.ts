import { DurableObject } from 'cloudflare:workers'
import {
  ACTIVITY_CATEGORY,
  type ActivityEvent,
  type ActivityType,
  type DataOrigin,
  type IngestBatch,
  type IngestResponse,
  type LiveSnapshot,
  type OfficialMetrics,
  type ProductConfig,
  type PublicConfig,
  type PurchaseKind,
  type SaleEvent,
  type ServerLive,
  type ServerMessage,
  type SourceStatus,
  type TodayStats,
} from '../shared/types'
import { addDays, dayKey, dayRangeUtc, dayStartUtc, isDayKey, listDays, resolveRange, type RangePreset } from '../shared/time'
import { appMode, authMode, secretStatus, type AppMode, type Env } from './env'
import { Db, sourceFilter } from './db'
import { applyConfigPatch, configFromRows, CONFIG_KEYS, type AppConfig } from './config'
import { computeBudget, emptyUsage, usageReport, utcDay, type UsageCounters } from './usage'
import { fetchOfficialGame, lookupUniverseId, nextPollDelayMs, RobloxRateLimitError, verifyOpenCloudKey } from './roblox'
import { fetchCloudflareUsage, type CloudflareUsage } from './cfusage'
import { validateBatch, ValidationError, MAX_BODY_BYTES } from './validate'
import { checkPassword, createSessionCookie, passwordModeReady } from './auth'
import {
  ccuSeries,
  computeWindow,
  dailyRowFromTotals,
  dailyRows,
  emptyTotals,
  productBreakdown,
  recomputeDay,
  revenueHourly,
  visitsHourly,
  type DailyRow,
  type WindowTotals,
} from './aggregate'

// ---------------------------------------------------------------------------
// Hot state (kept in memory, mirrored to Durable Object storage so it survives
// hibernation/eviction without re-reading D1).
// ---------------------------------------------------------------------------

interface ServerHot {
  jobId: string
  universeId: number | null
  placeId: number | null
  placeVersion: number | null
  privateServer: boolean
  source: DataOrigin
  startedAt: number
  lastSeenAt: number
  persistedSeenAt: number
  heartbeatSec: number
  players: Record<string, { j: number; n?: string }>
  peak: number
}

interface TodayHot extends TodayStats {
  ccuMinuteSum: number
}

interface OfficialHot {
  visits: number | null
  playing: number | null
  favorites: number | null
  name: string | null
  rootPlaceId: number | null
  fetchedAt: number | null
  changedAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  failures: number
  nextPollAt: number
  lastSnapshotAt: number
  baseline: { day: string; visits: number; at: number } | null
}

interface Meta {
  v: 1
  mode: AppMode
  tz: string
  seq: number
  today: TodayHot
  allTime: { revenue: number; sales: number; since: number | null }
  firstTrackedAt: number | null
  allTimePeak: { ccu: number; at: number | null }
  lastPeakEventAt: number
  milestonesHit: number[]
  goalHitDay: string | null
  lastEventAt: number | null
  lastPurchaseAt: number | null
  minute: { at: number; max: number; lastWrittenCcu: number }
  official: OfficialHot
  lastAggregateAt: number
  lastRecomputeAt: number
  dirtyDays: string[]
  lastRetentionDay: string | null
  backfillCursor: string | null
}

interface IngestLogEntry {
  at: number
  jobId: string
  source: DataOrigin
  events: number
  players: number | null
  accepted: number
  duplicates: number
  status: number
  error?: string
}

const SERVER_PREFIX = 'srv:'
const ACTIVE_TICK_MS = 30_000
const IDLE_TICK_MS = 300_000
const IDLE_OFFICIAL_POLL_SEC = 300
const AGGREGATE_EVERY_MS = 10 * 60_000
const RECOMPUTE_TODAY_EVERY_MS = 60 * 60_000
const PEAK_EVENT_MIN_GAP_MS = 10 * 60_000
const MAX_SERVERS_IN_SNAPSHOT = 200

function emptyToday(day: string): TodayHot {
  return {
    dayKey: day,
    revenue: 0,
    sales: 0,
    devProductRevenue: 0,
    gamePassRevenue: 0,
    devProductSales: 0,
    gamePassSales: 0,
    trackedVisits: 0,
    uniquePlayers: 0,
    peakCcu: 0,
    peakAt: null,
    avgCcu: null,
    sessionsEnded: 0,
    sessionSecondsTotal: 0,
    avgSessionSec: null,
    firstTrackedAt: null,
    ccuMinuteSum: 0,
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

function errorJson(status: number, message: string): Response {
  return json({ ok: false, error: message }, status)
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

interface SessionRow {
  sid: string
  u: number
  n: string | null
  job: string
  place: number | null
  j: number
  js: 'event' | 'reconciled'
  src: DataOrigin
}

interface CloseRow {
  sid: string
  at: number
  reason: 'left' | 'server_shutdown' | 'server_timeout'
}

interface PurchaseRow {
  key: string
  kind: PurchaseKind
  pid: number
  pname: string | null
  robux: number
  asrc: 'receipt' | 'list_price'
  u: number
  n: string | null
  job: string
  place: number | null
  purchaseId: string | null
  ctype: string | null
  at: number
  rcv: number
  src: DataOrigin
}

interface PendingEvent {
  type: ActivityType
  at: number
  source: DataOrigin
  data: Record<string, unknown>
}

export class AnalyticsHub extends DurableObject<Env> {
  private db: Db
  private usage: UsageCounters = emptyUsage(Date.now())
  private usagePersistedAt = 0
  private meta!: Meta
  private config!: AppConfig
  private products = new Map<string, ProductConfig>()
  private servers = new Map<string, ServerHot>()
  private dirtyServers = new Set<string>()
  private deletedServers = new Set<string>()
  private metaDirty = false
  private recentBatches = new Map<string, number>()
  private buckets = new Map<string, { tokens: number; at: number }>()
  private recentJoins: number[] = []
  private recentLeaves: number[] = []
  private recentLoaded = false
  private ingestLog: IngestLogEntry[] = []
  private cache = new Map<string, { at: number; ttl: number; value: unknown }>()
  private sseClients = new Set<WritableStreamDefaultWriter<Uint8Array>>()
  private alarmAt: number | null = null
  private cfUsage: CloudflareUsage | null = null
  private pendingSnapshots: { minute: number; ccu: number; max: number; servers: number; official: number | null; source: DataOrigin }[] = []

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.db = new Db(env.DB, () => this.usageNow())
    // Dashboard keep-alive pings are answered by the runtime without waking the
    // object, so idle viewers cost nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    ctx.blockConcurrencyWhile(() => this.load())
  }

  // -------------------------------------------------------------------------
  // Loading & persistence
  // -------------------------------------------------------------------------

  private usageNow(): UsageCounters {
    const now = Date.now()
    if (this.usage.day !== utcDay(now)) {
      this.usage = emptyUsage(now)
      this.usagePersistedAt = 0
    }
    return this.usage
  }

  private get mode(): AppMode {
    return appMode(this.env)
  }

  private counted(source: DataOrigin): boolean {
    return source === 'live' || (source === 'synthetic' && this.mode === 'development')
  }

  private async load(): Promise<void> {
    const now = Date.now()
    const stored = await this.ctx.storage.get(['meta', 'config', 'products', 'usage'])
    const servers = await this.ctx.storage.list<ServerHot>({ prefix: SERVER_PREFIX })
    this.usageNow().doStorage.reads += 4 + servers.size
    const usage = stored.get('usage') as UsageCounters | undefined
    if (usage && usage.day === utcDay(now)) this.usage = usage

    for (const [, s] of servers) this.servers.set(s.jobId, s)

    const cfg = stored.get('config') as AppConfig | undefined
    const products = stored.get('products') as ProductConfig[] | undefined
    if (cfg && products) {
      this.config = cfg
      for (const p of products) this.products.set(`${p.kind}:${p.productId}`, p)
    } else {
      await this.reloadConfigFromD1()
    }

    const meta = stored.get('meta') as Meta | undefined
    if (meta && meta.v === 1) {
      this.meta = meta
      if (meta.mode !== this.mode || meta.tz !== this.config.timezone) {
        // Mode or timezone changed: rebuild today's counters from the raw tables.
        this.meta.mode = this.mode
        this.meta.tz = this.config.timezone
        this.meta.today = emptyToday(dayKey(now, this.config.timezone))
        await this.recomputeToday(now)
        await this.recomputeAllTime()
        this.metaDirty = true
      }
    } else {
      await this.initMeta(now)
    }
    await this.persist()
  }

  private async reloadConfigFromD1(): Promise<void> {
    const rows = await this.db.all<{ key: string; value: string }>(`SELECT key, value FROM app_config`)
    this.config = configFromRows(this.env, rows)
    const prows = await this.db.all<{ kind: PurchaseKind; product_id: number; name: string | null; price_robux: number | null }>(
      `SELECT kind, product_id, name, price_robux FROM products`,
    )
    this.products.clear()
    for (const p of prows) {
      this.products.set(`${p.kind}:${p.product_id}`, { kind: p.kind, productId: p.product_id, name: p.name, priceRobux: p.price_robux })
    }
    await this.ctx.storage.put({ config: this.config, products: [...this.products.values()] })
    this.usageNow().doStorage.writes += 2
  }

  private async initMeta(now: number): Promise<void> {
    const tz = this.config.timezone
    const maxSeq = await this.db.first<{ s: number | null }>(`SELECT MAX(seq) AS s FROM activity_events`)
    const first = await this.db.first<{ t: number | null }>(
      `SELECT MIN(t) AS t FROM (SELECT MIN(started_at) AS t FROM player_sessions WHERE ${sourceFilter(this.mode)}
        UNION ALL SELECT MIN(purchased_at) FROM purchases WHERE ${sourceFilter(this.mode)})`,
    )
    const peak = await this.db.first<{ p: number | null }>(`SELECT MAX(peak_ccu) AS p FROM daily_aggregates WHERE tz = ?`, tz)
    this.meta = {
      v: 1,
      mode: this.mode,
      tz,
      seq: maxSeq?.s ?? 0,
      today: emptyToday(dayKey(now, tz)),
      allTime: { revenue: 0, sales: 0, since: null },
      firstTrackedAt: first?.t ?? null,
      allTimePeak: { ccu: peak?.p ?? 0, at: null },
      lastPeakEventAt: 0,
      milestonesHit: [],
      goalHitDay: null,
      lastEventAt: null,
      lastPurchaseAt: null,
      minute: { at: Math.floor(now / 60_000) * 60_000, max: 0, lastWrittenCcu: 0 },
      official: {
        visits: null,
        playing: null,
        favorites: null,
        name: null,
        rootPlaceId: null,
        fetchedAt: null,
        changedAt: null,
        lastError: null,
        lastErrorAt: null,
        failures: 0,
        nextPollAt: now,
        lastSnapshotAt: 0,
        baseline: null,
      },
      lastAggregateAt: 0,
      lastRecomputeAt: 0,
      dirtyDays: [],
      lastRetentionDay: null,
      backfillCursor: null,
    }
    await this.recomputeToday(now)
    await this.recomputeAllTime()
    // Milestones already passed before this hub started are not re-announced.
    this.meta.milestonesHit = this.config.milestones.filter((m) => this.meta.allTime.revenue >= m)
    const lastOfficial = await this.db.first<{ fetched_at: number; visits: number; playing: number | null; favorites: number | null }>(
      `SELECT fetched_at, visits, playing, favorites FROM official_snapshots ORDER BY fetched_at DESC LIMIT 1`,
    )
    if (lastOfficial) {
      Object.assign(this.meta.official, {
        visits: lastOfficial.visits,
        playing: lastOfficial.playing,
        favorites: lastOfficial.favorites,
        fetchedAt: lastOfficial.fetched_at,
        lastSnapshotAt: lastOfficial.fetched_at,
      })
    }
    this.metaDirty = true
  }

  private async recomputeToday(now: number): Promise<void> {
    const tz = this.config.timezone
    const day = dayKey(now, tz)
    const [start] = dayRangeUtc(day, tz)
    const t = await computeWindow(this.db, this.mode, start, now, { tz, fullDay: day, firstTrackedAt: this.meta.firstTrackedAt })
    const today = this.meta.today.dayKey === day ? this.meta.today : emptyToday(day)
    Object.assign(today, {
      dayKey: day,
      revenue: t.revenue,
      sales: t.sales,
      devProductRevenue: t.devProductRevenue,
      gamePassRevenue: t.gamePassRevenue,
      devProductSales: t.devProductSales,
      gamePassSales: t.gamePassSales,
      trackedVisits: t.trackedVisits,
      uniquePlayers: t.uniquePlayers,
      peakCcu: Math.max(t.peakCcu, today.peakCcu, this.currentCcu()),
      sessionsEnded: t.sessionsEnded,
      sessionSecondsTotal: t.sessionSecondsTotal,
      ccuMinuteSum: t.ccuMinuteSum,
    })
    this.meta.today = today
    this.meta.lastRecomputeAt = now
    this.metaDirty = true
  }

  private async recomputeAllTime(): Promise<void> {
    const r = await this.db.first<{ r: number | null; c: number; f: number | null }>(
      `SELECT COALESCE(SUM(robux),0) AS r, COUNT(*) AS c, MIN(purchased_at) AS f FROM purchases WHERE ${sourceFilter(this.mode)}`,
    )
    this.meta.allTime = { revenue: r?.r ?? 0, sales: r?.c ?? 0, since: r?.f ?? null }
    this.metaDirty = true
  }

  private async persist(): Promise<void> {
    const now = Date.now()
    const entries: Record<string, unknown> = {}
    if (this.metaDirty) entries.meta = this.meta
    for (const id of this.dirtyServers) {
      const s = this.servers.get(id)
      if (s) {
        s.persistedSeenAt = s.lastSeenAt
        entries[SERVER_PREFIX + id] = s
      }
    }
    if (now - this.usagePersistedAt > 30_000) {
      entries.usage = this.usageNow()
      this.usagePersistedAt = now
    }
    const keys = Object.keys(entries)
    const u = this.usageNow()
    if (keys.length) {
      u.doStorage.writes += keys.length
      await this.ctx.storage.put(entries)
    }
    if (this.deletedServers.size) {
      u.doStorage.writes += this.deletedServers.size
      await this.ctx.storage.delete([...this.deletedServers].map((id) => SERVER_PREFIX + id))
    }
    this.metaDirty = false
    this.dirtyServers.clear()
    this.deletedServers.clear()
    await this.ensureAlarm(now)
  }

  private desiredTickMs(): number {
    const active = this.liveServerCount() > 0 || this.viewerCount() > 0 || this.servers.size > 0
    return active ? ACTIVE_TICK_MS : IDLE_TICK_MS
  }

  private async ensureAlarm(now: number): Promise<void> {
    if (this.alarmAt === null) {
      this.alarmAt = await this.ctx.storage.getAlarm()
      this.usageNow().doStorage.reads += 1
    }
    const desired = now + this.desiredTickMs()
    if (this.alarmAt === null || this.alarmAt > desired || this.alarmAt < now - 60_000) {
      await this.ctx.storage.setAlarm(desired)
      this.alarmAt = desired
      this.usageNow().doStorage.writes += 1
    }
  }

  // -------------------------------------------------------------------------
  // Derived live values
  // -------------------------------------------------------------------------

  private currentCcu(): number {
    let total = 0
    for (const s of this.servers.values()) if (this.counted(s.source)) total += Object.keys(s.players).length
    return total
  }

  private liveServerCount(): number {
    let n = 0
    for (const s of this.servers.values()) if (this.counted(s.source)) n++
    return n
  }

  private viewerCount(): number {
    return this.ctx.getWebSockets().length + this.sseClients.size
  }

  private budget() {
    return computeBudget(this.usageNow(), this.liveServerCount(), Date.now())
  }

  private serverTimeoutMs(s: ServerHot): number {
    return Math.max(3 * s.heartbeatSec, 90) * 1000 + 30_000
  }

  private async ensureRecent(now: number): Promise<void> {
    if (this.recentLoaded) {
      const cutoff = now - 5 * 60_000
      while (this.recentJoins.length && this.recentJoins[0] < cutoff) this.recentJoins.shift()
      while (this.recentLeaves.length && this.recentLeaves[0] < cutoff) this.recentLeaves.shift()
      return
    }
    const since = now - 5 * 60_000
    const [joins, leaves] = await Promise.all([
      this.db.all<{ t: number }>(
        `SELECT started_at AS t FROM player_sessions WHERE ${sourceFilter(this.mode)} AND started_at >= ? ORDER BY started_at LIMIT 5000`,
        since,
      ),
      this.db.all<{ t: number }>(
        `SELECT ended_at AS t FROM player_sessions WHERE ${sourceFilter(this.mode)} AND ended_at >= ? ORDER BY ended_at LIMIT 5000`,
        since,
      ),
    ])
    this.recentJoins = joins.map((r) => r.t)
    this.recentLeaves = leaves.map((r) => r.t)
    this.recentLoaded = true
  }

  private officialMetrics(now: number): OfficialMetrics {
    const o = this.meta.official
    const pollSec = this.viewerCount() > 0 ? this.config.officialPollSec : IDLE_OFFICIAL_POLL_SEC
    let status: SourceStatus = 'waiting'
    if (!this.config.universeId) status = 'unavailable'
    else if (o.lastError && (!o.fetchedAt || (o.lastErrorAt ?? 0) > o.fetchedAt)) status = o.fetchedAt ? 'stale' : 'error'
    else if (o.fetchedAt) status = now - o.fetchedAt < Math.max(pollSec * 3, 120) * 1000 ? 'delayed' : 'stale'
    const baseline = o.baseline && o.baseline.day === this.meta.today.dayKey ? o.baseline : null
    if (!this.config.universeId) {
      // Never show numbers for a universe that is no longer configured.
      return { status, visits: null, playing: null, favorites: null, name: null, rootPlaceId: null, fetchedAt: null, changedAt: null, lastError: null, nextPollAt: null, pollSec, visitsToday: null, visitsTodayBaselineAt: null }
    }
    return {
      status,
      visits: o.visits,
      playing: o.playing,
      favorites: o.favorites,
      name: o.name,
      rootPlaceId: o.rootPlaceId,
      fetchedAt: o.fetchedAt,
      changedAt: o.changedAt,
      lastError: o.lastError,
      nextPollAt: o.nextPollAt,
      pollSec,
      visitsToday: baseline && o.visits !== null ? Math.max(0, o.visits - baseline.visits) : null,
      visitsTodayBaselineAt: baseline?.at ?? null,
    }
  }

  private liveSnapshot(now = Date.now()): LiveSnapshot {
    const servers: ServerLive[] = [...this.servers.values()]
      .map((s) => ({
        jobId: s.jobId,
        placeId: s.placeId,
        players: Object.keys(s.players).length,
        startedAt: s.startedAt,
        lastSeenAt: s.lastSeenAt,
        heartbeatSec: s.heartbeatSec,
        source: s.source,
        privateServer: s.privateServer,
      }))
      .sort((a, b) => b.players - a.players)
      .slice(0, MAX_SERVERS_IN_SNAPSHOT)
    const t = this.meta.today
    const [dayStart] = dayRangeUtc(t.dayKey, this.config.timezone)
    const coveredFrom = Math.max(dayStart, this.meta.firstTrackedAt ?? now)
    const minutes = Math.max(0, (now - coveredFrom) / 60_000)
    // Include the in-progress minute so the average moves in real time.
    const inProgress = this.currentCcu() * Math.max(0, (now - this.meta.minute.at) / 60_000)
    const today: TodayStats = {
      ...t,
      avgCcu: minutes >= 1 ? (t.ccuMinuteSum + inProgress) / minutes : null,
      avgSessionSec: t.sessionsEnded > 0 ? t.sessionSecondsTotal / t.sessionsEnded : null,
      firstTrackedAt: this.meta.firstTrackedAt,
    }
    delete (today as Partial<TodayHot>).ccuMinuteSum
    const lastEventAt = this.meta.lastEventAt
    let ingestStatus: SourceStatus = 'waiting'
    if (this.liveServerCount() > 0) ingestStatus = 'live'
    else if (lastEventAt && now - lastEventAt < 15 * 60_000) ingestStatus = 'live'
    else if (lastEventAt) ingestStatus = 'stale'
    return {
      serverTime: now,
      seq: this.meta.seq,
      mode: this.mode,
      tz: this.config.timezone,
      ccu: this.currentCcu(),
      activeServers: this.liveServerCount(),
      servers,
      joinsLast5m: this.recentJoins.length,
      leavesLast5m: this.recentLeaves.length,
      joinRatePerMin: this.recentJoins.length / 5,
      today,
      allTime: this.meta.allTime,
      official: this.officialMetrics(now),
      ingest: {
        status: ingestStatus,
        lastEventAt,
        lastPurchaseAt: this.meta.lastPurchaseAt,
        lastHeartbeatAt: servers.reduce<number | null>((acc, s) => (s.source === 'studio' ? acc : Math.max(acc ?? 0, s.lastSeenAt)), null),
      },
      budget: this.budget(),
      viewers: this.viewerCount(),
      dailyGoalRobux: this.config.dailyGoalRobux,
      netRevenueRate: this.config.netRevenueRate,
    }
  }

  // -------------------------------------------------------------------------
  // Broadcasting
  // -------------------------------------------------------------------------

  private broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text)
      } catch {
        // Socket already closing; the runtime cleans it up.
      }
    }
    if (this.sseClients.size) {
      const chunk = new TextEncoder().encode(`${'seq' in msg && typeof msg.seq === 'number' ? `id: ${msg.seq}\n` : ''}data: ${text}\n\n`)
      for (const w of this.sseClients) {
        w.write(chunk).catch(() => this.sseClients.delete(w))
      }
    }
  }

  private broadcastLive(): void {
    if (this.viewerCount() === 0) return
    this.broadcast({ t: 'live', live: this.liveSnapshot() })
  }

  /** Assigns sequence numbers, persists activity events, then broadcasts them. */
  private async recordEvents(events: PendingEvent[]): Promise<ActivityEvent[]> {
    if (!events.length) return []
    const first = this.meta.seq + 1
    this.meta.seq += events.length
    this.metaDirty = true
    // Reserve the sequence range durably before writing to D1 so a crash can never
    // reuse a sequence number (gaps are harmless; duplicates are not).
    await this.ctx.storage.put('meta', this.meta)
    this.usageNow().doStorage.writes += 1
    const out: ActivityEvent[] = events.map((e, i) => ({
      seq: first + i,
      type: e.type,
      category: ACTIVITY_CATEGORY[e.type],
      at: e.at,
      source: e.source,
      data: e.data,
    }))
    await this.db.run(
      `INSERT OR IGNORE INTO activity_events (seq, type, category, occurred_at, data, source)
       SELECT json_extract(value,'$.seq'), json_extract(value,'$.type'), json_extract(value,'$.category'),
              json_extract(value,'$.at'), json_extract(value,'$.data'), json_extract(value,'$.source')
       FROM json_each(?)`,
      JSON.stringify(out.map((e) => ({ ...e, data: JSON.stringify(e.data) }))),
    )
    for (const e of out) this.broadcast({ t: 'event', event: e })
    return out
  }

  // -------------------------------------------------------------------------
  // Request routing (only the Worker can reach this object)
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const kind = request.headers.get('x-rl-kind') ?? 'api'
    const u = this.usageNow()
    u.doRequests.fetch += 1
    if (kind === 'ingest') u.worker.ingest += 1
    else if (kind === 'ws') u.worker.ws += 1
    else if (kind === 'login') u.worker.login += 1
    else if (kind === 'cron') u.worker.cron += 1
    else u.worker.api += 1

    try {
      await this.rollDay(Date.now())
      const res = await this.route(request, url)
      await this.persist()
      return res
    } catch (err) {
      await this.persist().catch(() => {})
      if (err instanceof HttpError) return errorJson(err.status, err.message)
      if (err instanceof ValidationError) return errorJson(400, err.message)
      console.error('hub error', err)
      return errorJson(500, 'Internal error')
    }
  }

  private async route(request: Request, url: URL): Promise<Response> {
    const p = url.pathname
    const m = request.method
    if (p === '/ingest' && m === 'POST') return this.handleIngest(request)
    if (p === '/internal/cron') {
      await this.tick(Date.now())
      return json({ ok: true })
    }
    if (p === '/auth/login' && m === 'POST') return this.handleLogin(request)
    if (p === '/api/live') return this.handleWebSocket(request, url)
    if (p === '/api/stream') return this.handleSse(url)
    if (m === 'GET') {
      switch (p) {
        case '/api/bootstrap':
          return json(await this.bootstrap())
        case '/api/summary':
          return json(await this.summary(url))
        case '/api/series/ccu':
          return json(await this.seriesCcu(url))
        case '/api/series/revenue':
          return json(await this.seriesRevenue(url))
        case '/api/series/visits':
          return json(await this.seriesVisits(url))
        case '/api/products':
          return json(await this.products_(url))
        case '/api/activity':
          return json(await this.activity(url))
        case '/api/insights':
          return json(await this.insights())
        case '/api/export.csv':
          return this.exportCsv(url)
        case '/api/admin/usage':
          return json(await this.adminUsage(url))
        case '/api/admin/integration':
          return json(this.integration())
        case '/api/health':
          return json(this.health())
      }
    }
    if (m === 'POST') {
      const body = await readJson(request)
      switch (p) {
        case '/api/admin/config':
          return json(await this.updateConfig(body))
        case '/api/admin/products':
          return json(await this.updateProducts(body))
        case '/api/admin/lookup-universe':
          return json(await this.lookupUniverse(body))
        case '/api/admin/verify-open-cloud':
          return json(await this.verifyOpenCloud())
        case '/api/admin/poll-official':
          await this.pollOfficial(Date.now(), true)
          return json({ ok: true, official: this.officialMetrics(Date.now()) })
        case '/api/admin/recompute':
          return json(await this.adminRecompute(body))
        case '/api/admin/synthetic':
          return json(await this.synthetic(body))
      }
    }
    return errorJson(404, 'Not found')
  }

  // -------------------------------------------------------------------------
  // Authentication helpers that need shared state (login rate limiting)
  // -------------------------------------------------------------------------

  private takeToken(key: string, perMinute: number, burst = perMinute): boolean {
    const now = Date.now()
    const b = this.buckets.get(key) ?? { tokens: burst, at: now }
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 60_000) * perMinute)
    b.at = now
    if (b.tokens < 1) {
      this.buckets.set(key, b)
      return false
    }
    b.tokens -= 1
    this.buckets.set(key, b)
    if (this.buckets.size > 5000) {
      for (const [k, v] of this.buckets) if (now - v.at > 10 * 60_000) this.buckets.delete(k)
    }
    return true
  }

  private async handleLogin(request: Request): Promise<Response> {
    if (authMode(this.env) !== 'password') return errorJson(400, 'Password sign-in is disabled (AUTH_MODE is not "password").')
    const notReady = passwordModeReady(this.env)
    if (notReady) return errorJson(503, notReady)
    const ip = request.headers.get('x-rl-ip') ?? 'unknown'
    if (!this.takeToken(`login:${ip}`, 5, 5) || !this.takeToken('login:global', 30, 30)) {
      return errorJson(429, 'Too many sign-in attempts. Wait a minute and try again.')
    }
    const body = await readJson(request)
    const password = typeof body.password === 'string' ? body.password : ''
    if (!password || password.length > 256 || !(await checkPassword(password, this.env))) {
      return errorJson(401, 'Incorrect password')
    }
    return json({ ok: true }, 200, { 'set-cookie': await createSessionCookie(this.env) })
  }

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  private logIngest(entry: IngestLogEntry): void {
    this.ingestLog.unshift(entry)
    if (this.ingestLog.length > 30) this.ingestLog.length = 30
  }

  private async handleIngest(request: Request): Promise<Response> {
    const now = Date.now()
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return errorJson(413, 'Payload too large')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return errorJson(400, 'Body is not valid JSON')
    }
    let batch: IngestBatch
    try {
      batch = validateBatch(raw, now)
    } catch (err) {
      this.usageNow().ingest.rejected += 1
      const jobId = typeof (raw as { server?: { jobId?: unknown } })?.server?.jobId === 'string' ? String((raw as { server: { jobId: string } }).server.jobId).slice(0, 64) : '?'
      this.logIngest({ at: now, jobId, source: 'live', events: 0, players: null, accepted: 0, duplicates: 0, status: 400, error: (err as Error).message })
      throw err
    }
    if (!this.takeToken(`ingest:${batch.server.jobId}`, 120, 60) || !this.takeToken('ingest:global', 3000, 1500)) {
      this.logIngest({ at: now, jobId: batch.server.jobId, source: 'live', events: batch.events?.length ?? 0, players: null, accepted: 0, duplicates: 0, status: 429, error: 'rate limited' })
      return json({ ok: false, error: 'Rate limited', heartbeatSec: this.budget().heartbeatSec, flushSec: 10 }, 429, { 'retry-after': '10' })
    }
    const result = await this.ingest(batch, now)
    return json(result, result.ok ? 200 : 403)
  }

  /** Core ingestion. Exposed for the synthetic test generator. */
  async ingest(batch: IngestBatch, now: number): Promise<IngestResponse> {
    const budget = this.budget()
    const source: DataOrigin = batch.synthetic ? 'synthetic' : batch.server.studio ? 'studio' : 'live'
    const base = { heartbeatSec: budget.heartbeatSec, flushSec: budget.flushSec }
    const usage = this.usageNow()

    if (source === 'synthetic' && this.mode !== 'development') {
      return { ok: false, accepted: 0, duplicates: 0, rejected: 1, ...base, error: 'Synthetic events are only accepted in development mode' }
    }
    if (source === 'live' && this.config.universeId && batch.server.universeId && String(batch.server.universeId) !== this.config.universeId) {
      this.logIngest({ at: now, jobId: batch.server.jobId, source, events: 0, players: null, accepted: 0, duplicates: 0, status: 403, error: 'universe mismatch' })
      return { ok: false, accepted: 0, duplicates: 0, rejected: 1, ...base, error: 'Universe ID does not match the configured universe' }
    }
    // Replay / retry protection: a batch ID is processed once.
    for (const [id, t] of this.recentBatches) if (now - t > 15 * 60_000) this.recentBatches.delete(id)
    if (this.recentBatches.has(batch.batchId)) {
      usage.ingest.duplicates += 1
      return { ok: true, duplicate: true, accepted: 0, duplicates: batch.events?.length ?? 0, rejected: 0, ...base }
    }
    this.recentBatches.set(batch.batchId, now)
    usage.ingest.batches += 1
    usage.ingest.events += batch.events?.length ?? 0
    await this.ensureRecent(now)

    const tz = this.config.timezone
    const counted = this.counted(source)
    const jobId = batch.server.jobId
    const placeId = batch.server.placeId ?? null
    const sessions: SessionRow[] = []
    const closes: CloseRow[] = []
    const reopen: string[] = []
    const dailyPlayers: { day: string; u: number }[] = []
    const purchases: PurchaseRow[] = []
    const catalog: { kind: PurchaseKind; pid: number; name: string | null; price: number | null }[] = []
    const pending: PendingEvent[] = []
    const sid = (u: number, j: number) => `${jobId}:${u}:${j}`

    this.noteMinute(now)
    let srv = this.servers.get(jobId)
    let opened = false
    if (!srv) {
      opened = true
      srv = {
        jobId,
        universeId: batch.server.universeId ?? null,
        placeId,
        placeVersion: batch.server.placeVersion ?? null,
        privateServer: batch.server.privateServer === true,
        source,
        startedAt: Math.min(batch.server.startedAt ?? now, now),
        lastSeenAt: now,
        persistedSeenAt: 0,
        heartbeatSec: budget.heartbeatSec,
        players: {},
        peak: 0,
      }
      this.servers.set(jobId, srv)
    }
    const server = srv
    const rosterChanged = { v: opened }
    const addPlayer = (u: number, j: number, n: string | undefined, joinSource: 'event' | 'reconciled') => {
      const existing = server.players[String(u)]
      if (existing && existing.j === j) return
      if (existing) closes.push({ sid: sid(u, existing.j), at: j, reason: 'left' })
      server.players[String(u)] = { j, n }
      rosterChanged.v = true
      sessions.push({ sid: sid(u, j), u, n: n ?? null, job: jobId, place: placeId, j, js: joinSource, src: source })
      if (opened) reopen.push(sid(u, j))
      dailyPlayers.push({ day: dayKey(j, tz), u })
      // A player who joined before today but is online now is also active today.
      const today = this.meta.today.dayKey
      if (dayKey(j, tz) !== today) dailyPlayers.push({ day: today, u })
    }
    const removePlayer = (u: number, j: number, at: number, reason: CloseRow['reason']) => {
      sessions.push({ sid: sid(u, j), u, n: null, job: jobId, place: placeId, j, js: 'reconciled', src: source })
      closes.push({ sid: sid(u, j), at, reason })
      const existing = server.players[String(u)]
      if (existing && existing.j === j) {
        delete server.players[String(u)]
        rosterChanged.v = true
      }
    }

    let closing: number | null = null
    for (const ev of batch.events ?? []) {
      switch (ev.type) {
        case 'join':
          addPlayer(ev.u, ev.j, ev.n, 'event')
          break
        case 'leave':
          removePlayer(ev.u, ev.j, ev.at, 'left')
          break
        case 'purchase': {
          const product = this.products.get(`${ev.kind}:${ev.productId}`)
          purchases.push({
            key: ev.kind === 'developer_product' ? `dp:${ev.purchaseId}` : `gp:${ev.u}:${ev.productId}`,
            kind: ev.kind,
            pid: ev.productId,
            pname: product?.name ?? ev.productName ?? null,
            robux: ev.robux,
            asrc: ev.kind === 'developer_product' ? 'receipt' : 'list_price',
            u: ev.u,
            n: ev.n ?? server.players[String(ev.u)]?.n ?? null,
            job: jobId,
            place: ev.placeIdWherePurchased ?? placeId,
            purchaseId: ev.purchaseId ?? null,
            ctype: ev.currencyType ?? null,
            at: ev.at,
            rcv: now,
            src: source,
          })
          break
        }
        case 'catalog':
          catalog.push({ kind: ev.kind, pid: ev.productId, name: ev.name ?? null, price: ev.price ?? null })
          break
        case 'server_close':
          closing = ev.at
          break
      }
    }

    if (closing !== null) {
      for (const [u, p] of Object.entries(server.players)) closes.push({ sid: sid(Number(u), p.j), at: closing, reason: 'server_shutdown' })
      server.players = {}
    } else if (batch.players) {
      // Heartbeat reconciliation: the roster is the server's truth at `sentAt`.
      const roster = new Map(batch.players.map((p) => [String(p.u), p]))
      for (const p of batch.players) {
        const cur = server.players[String(p.u)]
        if (!cur || cur.j !== p.j) addPlayer(p.u, p.j, p.n, 'reconciled')
        else if (p.n && !cur.n) cur.n = p.n
      }
      for (const [u, p] of Object.entries(server.players)) {
        if (!roster.has(u)) removePlayer(Number(u), p.j, batch.sentAt, 'left')
      }
    }

    const playerCount = Object.keys(server.players).length
    server.peak = Math.max(server.peak, playerCount)
    server.lastSeenAt = now
    server.heartbeatSec = budget.heartbeatSec
    if (batch.server.placeVersion !== undefined) server.placeVersion = batch.server.placeVersion
    const needPersist = rosterChanged.v || now - server.persistedSeenAt >= this.serverTimeoutMs(server) / 3
    if (closing !== null) {
      this.servers.delete(jobId)
      this.deletedServers.add(jobId)
      this.dirtyServers.delete(jobId)
    } else if (needPersist) {
      this.dirtyServers.add(jobId)
    }

    // ---- Phase 1: idempotent writes (one D1 transaction, fixed statement count) ----
    const stmts: D1PreparedStatement[] = []
    const idx: Record<string, number> = {}
    const push = (name: string, stmt: D1PreparedStatement) => {
      idx[name] = stmts.length
      stmts.push(stmt)
    }
    if (opened || closing !== null) {
      push(
        'server',
        this.db.prepare(
          `INSERT INTO server_sessions (job_id, place_id, place_version, private_server, started_at, last_seen_at, ended_at, end_reason, peak_players, source)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT (job_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, ended_at = excluded.ended_at,
             end_reason = excluded.end_reason, peak_players = MAX(peak_players, excluded.peak_players)
           RETURNING started_at`,
          jobId,
          placeId,
          server.placeVersion,
          server.privateServer ? 1 : 0,
          server.startedAt,
          now,
          closing,
          closing !== null ? 'shutdown' : null,
          server.peak,
          source,
        ),
      )
    }
    if (sessions.length) {
      push(
        'sessions',
        this.db.prepare(
          `INSERT OR IGNORE INTO player_sessions (session_id, user_id, username, job_id, place_id, started_at, join_source, source)
           SELECT json_extract(value,'$.sid'), json_extract(value,'$.u'), json_extract(value,'$.n'), json_extract(value,'$.job'),
                  json_extract(value,'$.place'), json_extract(value,'$.j'), json_extract(value,'$.js'), json_extract(value,'$.src')
           FROM json_each(?) WHERE true
           RETURNING session_id, user_id, username, started_at, join_source`,
          JSON.stringify(sessions),
        ),
      )
    }
    if (reopen.length) {
      // A server that was presumed crashed came back: reopen its timed-out sessions.
      push(
        'reopen',
        this.db.prepare(
          `UPDATE player_sessions SET ended_at = NULL, duration_sec = NULL, end_reason = NULL
           WHERE session_id IN (SELECT value FROM json_each(?)) AND end_reason = 'server_timeout'
           RETURNING session_id`,
          JSON.stringify(reopen),
        ),
      )
    }
    if (closes.length) {
      push(
        'closes',
        this.db.prepare(
          `UPDATE player_sessions AS ps SET ended_at = v.at, duration_sec = MAX(0, (v.at - ps.started_at) / 1000), end_reason = v.reason
           FROM (SELECT json_extract(value,'$.sid') AS sid, json_extract(value,'$.at') AS at, json_extract(value,'$.reason') AS reason FROM json_each(?)) AS v
           WHERE ps.session_id = v.sid AND ps.ended_at IS NULL
           RETURNING session_id, user_id, username, ended_at, duration_sec, end_reason`,
          JSON.stringify(closes),
        ),
      )
    }
    if (dailyPlayers.length) {
      push(
        'daily',
        this.db.prepare(
          `INSERT OR IGNORE INTO daily_players (tz, day, user_id, source)
           SELECT ?1, json_extract(value,'$.day'), json_extract(value,'$.u'), ?2 FROM json_each(?3) WHERE true
           RETURNING day, user_id`,
          tz,
          source,
          JSON.stringify(dailyPlayers),
        ),
      )
    }
    if (purchases.length) {
      push(
        'purchases',
        this.db.prepare(
          `INSERT OR IGNORE INTO purchases (dedupe_key, kind, product_id, product_name, robux, amount_source, user_id, username, job_id, place_id,
             purchase_id, currency_type, purchased_at, received_at, source)
           SELECT json_extract(value,'$.key'), json_extract(value,'$.kind'), json_extract(value,'$.pid'), json_extract(value,'$.pname'),
                  json_extract(value,'$.robux'), json_extract(value,'$.asrc'), json_extract(value,'$.u'), json_extract(value,'$.n'),
                  json_extract(value,'$.job'), json_extract(value,'$.place'), json_extract(value,'$.purchaseId'), json_extract(value,'$.ctype'),
                  json_extract(value,'$.at'), json_extract(value,'$.rcv'), json_extract(value,'$.src')
           FROM json_each(?) WHERE true
           RETURNING dedupe_key, kind, product_id, product_name, robux, amount_source, user_id, username, purchased_at, received_at, source`,
          JSON.stringify(purchases),
        ),
      )
    }
    if (catalog.length) {
      push(
        'catalog',
        this.db.prepare(
          `INSERT INTO products (kind, product_id, name, price_robux, configured, info_source, updated_at)
           SELECT json_extract(value,'$.kind'), json_extract(value,'$.pid'), json_extract(value,'$.name'), json_extract(value,'$.price'), 0, 'game_server', ?2
           FROM json_each(?1) WHERE true
           ON CONFLICT (kind, product_id) DO UPDATE SET
             name = CASE WHEN products.configured = 1 AND products.name IS NOT NULL THEN products.name ELSE COALESCE(excluded.name, products.name) END,
             price_robux = COALESCE(excluded.price_robux, products.price_robux),
             updated_at = excluded.updated_at`,
          JSON.stringify(catalog),
          now,
        ),
      )
    }

    const results = await this.db.batch(stmts)
    const rowsOf = <T>(name: string): T[] => (idx[name] === undefined ? [] : ((results[idx[name]].results ?? []) as T[]))

    // ---- Interpret what actually changed (only real inserts/updates count) ----
    const today = this.meta.today
    if (counted && this.meta.firstTrackedAt === null) this.meta.firstTrackedAt = now
    const dirtyDays = new Set<string>()

    if (opened) {
      pending.push({ type: 'server_open', at: server.startedAt, source, data: { jobId, placeId, privateServer: server.privateServer } })
    }

    const logJoinLeave = budget.joinLeaveLogging
    for (const r of rowsOf<{ session_id: string; user_id: number; username: string | null; started_at: number; join_source: string }>('sessions')) {
      if (!counted && source !== 'studio') continue
      const d = dayKey(r.started_at, tz)
      if (counted) {
        if (d === today.dayKey) today.trackedVisits += 1
        else dirtyDays.add(d)
        this.recentJoins.push(r.started_at)
      }
      // Sessions created only to close a missed join are not shown as "joined".
      const stillHere = server.players[String(r.user_id)]?.j === r.started_at
      if (logJoinLeave && (stillHere || r.join_source === 'event')) {
        pending.push({
          type: 'player_join',
          at: r.started_at,
          source,
          data: { userId: r.user_id, username: r.username, jobId, reconciled: r.join_source === 'reconciled' },
        })
      }
    }
    for (const r of rowsOf<{ day: string; user_id: number }>('daily')) {
      if (!counted) continue
      if (r.day === today.dayKey) today.uniquePlayers += 1
      else dirtyDays.add(r.day)
    }
    for (const r of rowsOf<{ session_id: string; user_id: number; username: string | null; ended_at: number; duration_sec: number; end_reason: string }>(
      'closes',
    )) {
      if (counted) {
        const d = dayKey(r.ended_at, tz)
        if (d === today.dayKey) {
          today.sessionsEnded += 1
          today.sessionSecondsTotal += r.duration_sec
        } else dirtyDays.add(d)
        this.recentLeaves.push(r.ended_at)
      }
      if (logJoinLeave && (counted || source === 'studio')) {
        pending.push({
          type: 'player_leave',
          at: r.ended_at,
          source,
          data: { userId: r.user_id, username: r.username, jobId, sessionSec: r.duration_sec, reason: r.end_reason },
        })
      }
    }
    if (rowsOf('reopen').length && counted) dirtyDays.add(today.dayKey)

    const sales: SaleEvent[] = []
    const purchaseRows = rowsOf<{
      dedupe_key: string
      kind: PurchaseKind
      product_id: number
      product_name: string | null
      robux: number
      amount_source: 'receipt' | 'list_price'
      user_id: number
      username: string | null
      purchased_at: number
      received_at: number
      source: DataOrigin
    }>('purchases')
    for (const r of purchaseRows) {
      const sale: SaleEvent = {
        dedupeKey: r.dedupe_key,
        kind: r.kind,
        productId: r.product_id,
        productName: r.product_name,
        robux: r.robux,
        amountSource: r.amount_source,
        userId: r.user_id,
        username: r.username,
        purchasedAt: r.purchased_at,
        receivedAt: r.received_at,
        source: r.source,
      }
      sales.push(sale)
      if (!counted) continue
      const d = dayKey(r.purchased_at, tz)
      if (d === today.dayKey) {
        today.revenue += r.robux
        today.sales += 1
        if (r.kind === 'game_pass') {
          today.gamePassRevenue += r.robux
          today.gamePassSales += 1
        } else {
          today.devProductRevenue += r.robux
          today.devProductSales += 1
        }
      } else dirtyDays.add(d)
      this.meta.allTime.revenue += r.robux
      this.meta.allTime.sales += 1
      this.meta.allTime.since = Math.min(this.meta.allTime.since ?? r.purchased_at, r.purchased_at)
      this.meta.lastPurchaseAt = now
    }
    const duplicates = purchases.length - purchaseRows.length
    if (duplicates > 0) usage.ingest.duplicates += duplicates
    for (const s of sales) {
      pending.push({
        type: 'purchase',
        at: s.purchasedAt,
        source: s.source,
        data: { ...s },
      })
    }
    if (catalog.length) {
      for (const c of catalog) {
        const key = `${c.kind}:${c.pid}`
        const cur = this.products.get(key)
        this.products.set(key, { kind: c.kind, productId: c.pid, name: cur?.name ?? c.name, priceRobux: c.price ?? cur?.priceRobux ?? null })
      }
      await this.ctx.storage.put('products', [...this.products.values()])
      usage.doStorage.writes += 1
    }
    if (closing !== null) {
      pending.push({ type: 'server_close', at: closing, source, data: { jobId, placeId, reason: 'shutdown', uptimeSec: Math.round((closing - server.startedAt) / 1000), peakPlayers: server.peak } })
    }

    // Milestones / goals / peaks.
    if (counted && sales.length) this.checkRevenueMilestones(pending, now)
    if (counted) this.checkPeak(pending, now)
    this.noteMinute(now)

    if (dirtyDays.size) this.meta.dirtyDays = [...new Set([...this.meta.dirtyDays, ...dirtyDays])].slice(-60)
    if (sessions.length || closes.length || purchases.length || opened || closing !== null) {
      this.meta.lastEventAt = now
      this.metaDirty = true
    }
    // Pure heartbeats with no changes cost no storage writes.
    if (stmts.length || pending.length) this.metaDirty = true

    // ---- Phase 2: activity feed + realtime broadcast ----
    const recorded = await this.recordEvents(pending)
    for (const ev of recorded) {
      if (ev.type === 'purchase') {
        this.broadcast({ t: 'sale', sale: ev.data as unknown as SaleEvent, seq: ev.seq })
      }
    }
    if (sales.length) this.invalidate('rev')
    this.broadcastLive()

    const accepted = (batch.events?.length ?? 0) - duplicates
    this.logIngest({ at: now, jobId, source, events: batch.events?.length ?? 0, players: batch.players?.length ?? null, accepted, duplicates, status: 200 })

    return {
      ok: true,
      accepted,
      duplicates,
      rejected: 0,
      ...base,
      catalogRequest: opened ? this.catalogRequest(now) : undefined,
    }
  }

  private catalogRequest(_now: number): { kind: PurchaseKind; productId: number }[] | undefined {
    const need = [...this.products.values()].filter((p) => !p.name || p.priceRobux === null).slice(0, 50)
    return need.length ? need.map((p) => ({ kind: p.kind, productId: p.productId })) : undefined
  }

  private checkRevenueMilestones(pending: PendingEvent[], now: number): void {
    for (const m of this.config.milestones) {
      if (this.meta.allTime.revenue >= m && !this.meta.milestonesHit.includes(m)) {
        this.meta.milestonesHit.push(m)
        pending.push({ type: 'milestone', at: now, source: 'live', data: { amount: m, total: this.meta.allTime.revenue, scope: 'all_time_revenue' } })
      }
    }
    const goal = this.config.dailyGoalRobux
    const t = this.meta.today
    if (goal && t.revenue >= goal && this.meta.goalHitDay !== t.dayKey) {
      this.meta.goalHitDay = t.dayKey
      pending.push({ type: 'goal_reached', at: now, source: 'live', data: { goal, revenue: t.revenue, day: t.dayKey } })
    }
  }

  private checkPeak(pending: PendingEvent[], now: number): void {
    const ccu = this.currentCcu()
    const t = this.meta.today
    if (ccu > this.meta.allTimePeak.ccu) {
      this.meta.allTimePeak = { ccu, at: now }
      if (ccu > t.peakCcu) {
        t.peakCcu = ccu
        t.peakAt = now
      }
      if (ccu >= 2 && now - this.meta.lastPeakEventAt > 60_000) {
        this.meta.lastPeakEventAt = now
        pending.push({ type: 'ccu_peak', at: now, source: 'live', data: { ccu, scope: 'all_time' } })
      }
      return
    }
    if (ccu > t.peakCcu) {
      t.peakCcu = ccu
      t.peakAt = now
      if (ccu >= 2 && now - this.meta.lastPeakEventAt > PEAK_EVENT_MIN_GAP_MS) {
        this.meta.lastPeakEventAt = now
        pending.push({ type: 'ccu_peak', at: now, source: 'live', data: { ccu, scope: 'today' } })
      }
    }
  }

  /**
   * Tracks the per-minute CCU accumulator. When a minute boundary passes, the
   * finished minute becomes a snapshot row (written in batches by the alarm).
   */
  private noteMinute(now: number): void {
    const minute = Math.floor(now / 60_000) * 60_000
    const ccu = this.currentCcu()
    const m = this.meta.minute
    if (m.at !== minute) {
      const servers = this.liveServerCount()
      const anyActivity = m.max > 0 || ccu > 0 || m.lastWrittenCcu > 0 || servers > 0
      const official = this.meta.official.fetchedAt && now - this.meta.official.fetchedAt < 120_000 ? this.meta.official.playing : null
      if (anyActivity && this.meta.firstTrackedAt !== null) {
        const synth = this.mode === 'development' && [...this.servers.values()].some((s) => s.source === 'synthetic')
        // The player count has not changed since the last boundary (every change
        // passes through here first), so each elapsed minute had `ccu` players.
        // Idle gaps are capped; with no servers they are zero-player minutes anyway.
        let count = 0
        for (let t = m.at; t < minute && count < 60; t += 60_000, count++) {
          const max = t === m.at ? Math.max(m.max, ccu) : ccu
          if (count > 0 && ccu === 0) break
          this.pendingSnapshots.push({ minute: t, ccu, max, servers, official, source: synth ? 'synthetic' : 'live' })
          if (dayKey(t, this.config.timezone) === this.meta.today.dayKey) this.meta.today.ccuMinuteSum += ccu
        }
        m.lastWrittenCcu = ccu
      }
      this.meta.minute = { at: minute, max: ccu, lastWrittenCcu: m.lastWrittenCcu }
      this.metaDirty = true
    } else if (ccu > m.max) {
      m.max = ccu
      this.metaDirty = true
    }
  }

  // -------------------------------------------------------------------------
  // Day rollover, alarms, reconciliation
  // -------------------------------------------------------------------------

  private async rollDay(now: number): Promise<void> {
    const tz = this.config.timezone
    const day = dayKey(now, tz)
    if (this.meta.today.dayKey === day) return
    const prev = this.meta.today.dayKey
    this.meta.dirtyDays = [...new Set([...this.meta.dirtyDays, prev])]
    const t = emptyToday(day)
    t.peakCcu = this.currentCcu()
    t.peakAt = t.peakCcu > 0 ? now : null
    this.meta.today = t
    const visits = this.meta.official.visits
    this.meta.official.baseline = visits !== null ? { day, visits, at: now } : null
    this.metaDirty = true
    // Players online across midnight count as active on the new day.
    await this.carryPlayersIntoDay(day)
  }

  private async carryPlayersIntoDay(day: string): Promise<void> {
    const rows: { u: number; src: DataOrigin }[] = []
    for (const s of this.servers.values()) {
      if (!this.counted(s.source)) continue
      for (const u of Object.keys(s.players)) rows.push({ u: Number(u), src: s.source })
    }
    if (!rows.length) return
    const res = await this.db.run(
      `INSERT OR IGNORE INTO daily_players (tz, day, user_id, source)
       SELECT ?1, ?2, json_extract(value,'$.u'), json_extract(value,'$.src') FROM json_each(?3) WHERE true`,
      this.config.timezone,
      day,
      JSON.stringify(rows),
    )
    if (this.meta.today.dayKey === day) {
      this.meta.today.uniquePlayers += res.meta.changes ?? 0
      this.metaDirty = true
    }
  }

  async alarm(): Promise<void> {
    this.alarmAt = null
    this.usageNow().doRequests.alarm += 1
    try {
      await this.tick(Date.now())
    } catch (err) {
      console.error('alarm tick failed', err)
    }
    await this.persist()
  }

  private async tick(now: number): Promise<void> {
    await this.rollDay(now)
    await this.reapServers(now)
    this.noteMinute(now)
    await this.flushSnapshots()
    await this.pollOfficial(now, false)
    await this.maintainAggregates(now)
    if (this.viewerCount() > 0) {
      await this.ensureRecent(now)
      this.broadcastLive()
    }
  }

  /** Closes servers whose heartbeats stopped (crash, network loss, missed shutdown). */
  private async reapServers(now: number): Promise<void> {
    const dead = [...this.servers.values()].filter((s) => now - s.lastSeenAt > this.serverTimeoutMs(s))
    if (!dead.length) return
    const closes: CloseRow[] = []
    const pending: PendingEvent[] = []
    for (const s of dead) {
      for (const [u, p] of Object.entries(s.players)) closes.push({ sid: `${s.jobId}:${u}:${p.j}`, at: Math.max(p.j, s.lastSeenAt), reason: 'server_timeout' })
      this.servers.delete(s.jobId)
      this.deletedServers.add(s.jobId)
      this.dirtyServers.delete(s.jobId)
      pending.push({
        type: 'server_close',
        at: s.lastSeenAt,
        source: s.source,
        data: { jobId: s.jobId, placeId: s.placeId, reason: 'heartbeat_timeout', uptimeSec: Math.round((s.lastSeenAt - s.startedAt) / 1000), peakPlayers: s.peak, playersDropped: Object.keys(s.players).length },
      })
    }
    const stmts = [
      this.db.prepare(
        `UPDATE server_sessions AS ss SET ended_at = v.at, end_reason = 'heartbeat_timeout', last_seen_at = v.at, peak_players = MAX(ss.peak_players, v.peak)
         FROM (SELECT json_extract(value,'$.job') AS job, json_extract(value,'$.at') AS at, json_extract(value,'$.peak') AS peak FROM json_each(?)) AS v
         WHERE ss.job_id = v.job AND ss.ended_at IS NULL`,
        JSON.stringify(dead.map((s) => ({ job: s.jobId, at: s.lastSeenAt, peak: s.peak }))),
      ),
    ]
    if (closes.length) {
      stmts.push(
        this.db.prepare(
          `UPDATE player_sessions AS ps SET ended_at = v.at, duration_sec = MAX(0, (v.at - ps.started_at) / 1000), end_reason = v.reason
           FROM (SELECT json_extract(value,'$.sid') AS sid, json_extract(value,'$.at') AS at, json_extract(value,'$.reason') AS reason FROM json_each(?)) AS v
           WHERE ps.session_id = v.sid AND ps.ended_at IS NULL
           RETURNING ended_at, duration_sec, source`,
          JSON.stringify(closes),
        ),
      )
    }
    const res = await this.db.batch(stmts)
    const closed = (res[1]?.results ?? []) as { ended_at: number; duration_sec: number; source: DataOrigin }[]
    for (const r of closed) {
      if (!this.counted(r.source)) continue
      const d = dayKey(r.ended_at, this.config.timezone)
      if (d === this.meta.today.dayKey) {
        this.meta.today.sessionsEnded += 1
        this.meta.today.sessionSecondsTotal += r.duration_sec
      } else this.meta.dirtyDays = [...new Set([...this.meta.dirtyDays, d])]
      this.recentLeaves.push(r.ended_at)
    }
    this.metaDirty = true
    await this.recordEvents(pending)
    this.broadcastLive()
  }

  private async flushSnapshots(): Promise<void> {
    if (!this.pendingSnapshots.length) return
    const every = this.budget().snapshotEverySec
    let rows = this.pendingSnapshots
    if (every > 60) rows = rows.filter((r) => (r.minute / 60_000) % Math.round(every / 60) === 0 || r.max !== r.ccu)
    this.pendingSnapshots = []
    if (!rows.length) return
    await this.db.run(
      `INSERT OR REPLACE INTO ccu_snapshots (minute_at, tracked_ccu, tracked_max, servers, official_ccu, source)
       SELECT json_extract(value,'$.minute'), json_extract(value,'$.ccu'), json_extract(value,'$.max'), json_extract(value,'$.servers'),
              json_extract(value,'$.official'), json_extract(value,'$.source') FROM json_each(?) WHERE true`,
      JSON.stringify(rows),
    )
    this.invalidate('ccu')
  }

  private async pollOfficial(now: number, force: boolean): Promise<void> {
    const o = this.meta.official
    const universeId = this.config.universeId
    if (!universeId) return
    if (!force && now < o.nextPollAt) return
    const pollSec = this.viewerCount() > 0 ? this.config.officialPollSec : IDLE_OFFICIAL_POLL_SEC
    const usage = this.usageNow()
    usage.roblox.requests += 1
    try {
      const g = await fetchOfficialGame(universeId)
      const changed = g.visits !== o.visits || g.playing !== o.playing || g.favorites !== o.favorites
      const visitsChanged = g.visits !== o.visits
      Object.assign(o, {
        visits: g.visits,
        playing: g.playing,
        favorites: g.favorites,
        name: g.name,
        rootPlaceId: g.rootPlaceId,
        fetchedAt: now,
        failures: 0,
        lastError: null,
        nextPollAt: now + nextPollDelayMs(pollSec, 0),
      })
      if (visitsChanged) o.changedAt = now
      const today = this.meta.today.dayKey
      if (!o.baseline || o.baseline.day !== today) o.baseline = { day: today, visits: g.visits, at: now }
      // Persist when the counters change, and at least hourly for day boundaries.
      if (changed || now - o.lastSnapshotAt > 3_600_000) {
        await this.db.run(
          `INSERT OR REPLACE INTO official_snapshots (fetched_at, visits, playing, favorites) VALUES (?, ?, ?, ?)`,
          now,
          g.visits,
          g.playing,
          g.favorites,
        )
        o.lastSnapshotAt = now
      }
      this.metaDirty = true
      // Broadcast as soon as a new verified value is detected.
      if (changed) this.broadcastLive()
    } catch (err) {
      o.failures += 1
      o.lastError = (err as Error).message
      o.lastErrorAt = now
      usage.roblox.errors += 1
      const retryAfter = err instanceof RobloxRateLimitError ? err.retryAfterSec : undefined
      if (retryAfter) usage.roblox.rateLimited += 1
      o.nextPollAt = now + nextPollDelayMs(pollSec, o.failures, retryAfter)
      this.metaDirty = true
      if (force) throw new HttpError(502, `Roblox request failed: ${o.lastError}`)
    }
  }

  private async maintainAggregates(now: number): Promise<void> {
    const tz = this.config.timezone
    const today = this.meta.today.dayKey
    // Finalise / repair days touched by rollovers or late events (a few per tick).
    const dirty = this.meta.dirtyDays.filter((d) => d !== today).slice(0, 3)
    for (const d of dirty) {
      await recomputeDay(this.db, this.mode, tz, d, this.meta.firstTrackedAt, now)
      this.meta.dirtyDays = this.meta.dirtyDays.filter((x) => x !== d)
      this.metaDirty = true
      this.invalidate('sum')
    }
    if (now - this.meta.lastRecomputeAt > RECOMPUTE_TODAY_EVERY_MS) {
      // Hourly drift correction of the incremental counters.
      await this.recomputeToday(now)
    }
    if (now - this.meta.lastAggregateAt > AGGREGATE_EVERY_MS) {
      await recomputeDay(this.db, this.mode, tz, today, this.meta.firstTrackedAt, now)
      this.meta.lastAggregateAt = now
      this.metaDirty = true
    }
    // After a timezone change, rebuild history for the new zone a few days per tick.
    if (this.meta.backfillCursor) {
      const first = this.meta.firstTrackedAt ? dayKey(this.meta.firstTrackedAt, tz) : today
      let cursor = this.meta.backfillCursor
      for (let i = 0; i < 3 && cursor >= first; i++) {
        await recomputeDay(this.db, this.mode, tz, cursor, this.meta.firstTrackedAt, now)
        cursor = addDays(cursor, -1)
      }
      this.meta.backfillCursor = cursor >= first ? cursor : null
      this.metaDirty = true
    }
    const utcToday = utcDay(now)
    if (this.meta.lastRetentionDay !== utcToday) {
      await this.applyRetention(now)
      this.meta.lastRetentionDay = utcToday
      this.metaDirty = true
    }
  }

  private async applyRetention(now: number): Promise<void> {
    const day = 86_400_000
    const cutoffDay = (days: number) => dayKey(now - days * day, this.config.timezone)
    // Deletes also count as rows written, so they run once a day in small batches.
    await this.db.batch([
      this.db.prepare(
        `DELETE FROM activity_events WHERE seq IN (SELECT seq FROM activity_events WHERE occurred_at < ? ORDER BY seq LIMIT 5000)`,
        now - this.config.activityRetentionDays * day,
      ),
      this.db.prepare(`DELETE FROM ccu_snapshots WHERE minute_at IN (SELECT minute_at FROM ccu_snapshots WHERE minute_at < ? LIMIT 5000)`, now - 120 * day),
      this.db.prepare(
        `DELETE FROM player_sessions WHERE session_id IN (SELECT session_id FROM player_sessions WHERE source IN ('live','studio','synthetic') AND started_at < ? LIMIT 5000)`,
        now - 180 * day,
      ),
      this.db.prepare(`DELETE FROM daily_players WHERE tz = ? AND day < ?`, this.config.timezone, cutoffDay(120)),
      this.db.prepare(`DELETE FROM server_sessions WHERE job_id IN (SELECT job_id FROM server_sessions WHERE source IN ('live','studio','synthetic') AND started_at < ? LIMIT 5000)`, now - 180 * day),
      this.db.prepare(`DELETE FROM official_snapshots WHERE fetched_at < ?`, now - 400 * day),
    ])
  }

  // -------------------------------------------------------------------------
  // Realtime connections
  // -------------------------------------------------------------------------

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return errorJson(426, 'Expected a WebSocket upgrade')
    if (this.ctx.getWebSockets().length >= 500) return errorJson(503, 'Too many dashboard connections')
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    const since = Number(url.searchParams.get('since'))
    await this.ensureRecent(Date.now())
    const { missed, gap } = await this.missedEvents(since)
    server.send(JSON.stringify({ t: 'hello', live: this.liveSnapshot(), missed, gap } satisfies ServerMessage))
    return new Response(null, { status: 101, webSocket: client })
  }

  private async missedEvents(since: number): Promise<{ missed: ActivityEvent[]; gap: boolean }> {
    if (!Number.isInteger(since) || since <= 0 || since >= this.meta.seq) return { missed: [], gap: false }
    const rows = await this.db.all<{ seq: number; type: ActivityType; category: ActivityEvent['category']; occurred_at: number; data: string; source: DataOrigin }>(
      `SELECT seq, type, category, occurred_at, data, source FROM activity_events WHERE seq > ? ORDER BY seq LIMIT 201`,
      since,
    )
    const gap = rows.length > 200
    return { missed: rows.slice(0, 200).map(rowToEvent), gap }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.usageNow().wsMessagesIn += 1
    if (typeof message !== 'string' || message.length > 512) return
    try {
      const msg = JSON.parse(message) as { t?: string; since?: number }
      if (msg.t === 'resume') {
        const { missed, gap } = await this.missedEvents(Number(msg.since))
        ws.send(JSON.stringify({ t: 'hello', live: this.liveSnapshot(), missed, gap } satisfies ServerMessage))
      }
    } catch {
      // Ignore malformed client messages.
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason)
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error')
    } catch {
      // already closed
    }
  }

  /**
   * Server-Sent Events fallback for networks that block WebSockets. An open SSE
   * stream keeps the Durable Object awake (duration is billed), so each stream
   * closes after 2 minutes and the browser reconnects with Last-Event-ID.
   */
  private async handleSse(url: URL): Promise<Response> {
    if (this.sseClients.size >= 50) return errorJson(503, 'Too many streaming connections')
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    this.sseClients.add(writer)
    const enc = new TextEncoder()
    const since = Number(url.searchParams.get('since'))
    await this.ensureRecent(Date.now())
    const { missed, gap } = await this.missedEvents(since)
    writer.write(enc.encode(`retry: 3000\ndata: ${JSON.stringify({ t: 'hello', live: this.liveSnapshot(), missed, gap })}\n\n`)).catch(() => {})
    const close = () => {
      this.sseClients.delete(writer)
      writer.close().catch(() => {})
    }
    setTimeout(close, 120_000)
    return new Response(readable, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
    })
  }

  // -------------------------------------------------------------------------
  // Read APIs
  // -------------------------------------------------------------------------

  private invalidate(prefix: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k)
  }

  private async cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    const now = Date.now()
    if (hit && now - hit.at < hit.ttl) return hit.value as T
    const value = await fn()
    this.cache.set(key, { at: now, ttl: ttlMs, value })
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value as string)
    return value
  }

  publicConfig(): PublicConfig {
    return {
      ...this.config,
      products: [...this.products.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.productId - b.productId),
      mode: this.mode,
      authMode: authMode(this.env),
      secrets: secretStatus(this.env),
    }
  }

  private async bootstrap() {
    const now = Date.now()
    await this.ensureRecent(now)
    const recent = await this.activityRows({ limit: 50, categories: null, includeTest: false })
    return { config: this.publicConfig(), live: this.liveSnapshot(now), recent, firstTrackedAt: this.meta.firstTrackedAt }
  }

  private parseRange(url: URL) {
    const preset = (url.searchParams.get('range') ?? 'today') as RangePreset
    const allowed: RangePreset[] = ['today', 'yesterday', '7d', '30d', 'week', 'month', 'all', 'custom']
    if (!allowed.includes(preset)) throw new HttpError(400, 'Unknown range')
    const tz = this.config.timezone
    const earliest = this.meta.firstTrackedAt ? dayKey(this.meta.firstTrackedAt, tz) : undefined
    try {
      return resolveRange(preset, Date.now(), tz, { from: url.searchParams.get('from') ?? undefined, to: url.searchParams.get('to') ?? undefined }, earliest)
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
  }

  private todayAsTotals(): WindowTotals {
    const live = this.liveSnapshot()
    const t = live.today
    return {
      ...emptyTotals(),
      revenue: t.revenue,
      sales: t.sales,
      devProductRevenue: t.devProductRevenue,
      devProductSales: t.devProductSales,
      gamePassRevenue: t.gamePassRevenue,
      gamePassSales: t.gamePassSales,
      trackedVisits: t.trackedVisits,
      uniquePlayers: t.uniquePlayers,
      peakCcu: t.peakCcu,
      avgCcu: t.avgCcu,
      sessionsEnded: t.sessionsEnded,
      sessionSecondsTotal: t.sessionSecondsTotal,
      avgSessionSec: t.avgSessionSec,
      trackedMinutes: t.avgCcu === null ? 0 : Math.round((live.serverTime - Math.max(dayStartUtc(t.dayKey, this.config.timezone), this.meta.firstTrackedAt ?? live.serverTime)) / 60_000),
      officialNewVisits: live.official.visitsToday,
    }
  }

  /** Daily rows for a range: stored aggregates for past days, live counters for today. */
  private async rangeDaily(fromDay: string, toDay: string): Promise<DailyRow[]> {
    const tz = this.config.timezone
    const today = this.meta.today.dayKey
    const stored = await this.cached(`sum:daily:${fromDay}:${toDay}`, 60_000, () => dailyRows(this.db, tz, fromDay, toDay < today ? toDay : addDays(today, -1)))
    const byDay = new Map(stored.map((r) => [r.day, r]))
    const firstDay = this.meta.firstTrackedAt ? dayKey(this.meta.firstTrackedAt, tz) : today
    // Past days that have data but no aggregate yet (e.g. right after deploy) are computed now.
    const allMissing = listDays(fromDay, toDay).filter((d) => d !== today && d >= firstDay && !byDay.has(d))
    const missing = allMissing.slice(0, 7)
    if (allMissing.length > missing.length) {
      // Compute the rest in the background alarm instead of this request.
      this.meta.dirtyDays = [...new Set([...this.meta.dirtyDays, ...allMissing.slice(7, 67)])]
      this.metaDirty = true
    }
    for (const d of missing) {
      const t = await recomputeDay(this.db, this.mode, tz, d, this.meta.firstTrackedAt, Date.now())
      byDay.set(d, dailyRowFromTotals(d, t, true))
      this.invalidate('sum:daily')
    }
    if (toDay >= today && fromDay <= today) byDay.set(today, dailyRowFromTotals(today, this.todayAsTotals(), false))
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
  }

  private async totalsFor(fromDay: string, toDay: string, startMs: number, endMs: number): Promise<WindowTotals & { days: number; daysWithData: number }> {
    const tz = this.config.timezone
    const today = this.meta.today.dayKey
    const lastDayEnd = dayRangeUtc(toDay, tz)[1]
    const partialLast = toDay !== today && endMs < lastDayEnd
    const rows = await this.rangeDaily(fromDay, partialLast ? addDays(toDay, -1) : toDay)
    const parts: WindowTotals[] = rows.filter((r) => r.day >= fromDay).map((r) => ({
      ...emptyTotals(),
      revenue: r.revenue,
      sales: r.sales,
      devProductRevenue: r.devProductRevenue,
      gamePassRevenue: r.gamePassRevenue,
      trackedVisits: r.trackedVisits,
      uniquePlayers: r.uniquePlayers,
      peakCcu: r.peakCcu,
      avgCcu: r.avgCcu,
      trackedMinutes: r.trackedMinutes,
      sessionsEnded: r.sessionsEnded,
      avgSessionSec: r.avgSessionSec,
      officialNewVisits: r.officialNewVisits,
    }))
    if (partialLast) {
      const [ds] = dayRangeUtc(toDay, tz)
      parts.push(
        await this.cached(`sum:partial:${toDay}:${Math.floor(endMs / 60_000)}`, 60_000, () =>
          computeWindow(this.db, this.mode, ds, endMs, { tz, firstTrackedAt: this.meta.firstTrackedAt }),
        ),
      )
    }
    const out = { ...emptyTotals(), days: listDays(fromDay, toDay).length, daysWithData: 0 }
    let ccuWeighted = 0
    let sessionWeighted = 0
    let officialKnown = false
    for (const p of parts) {
      out.revenue += p.revenue
      out.sales += p.sales
      out.devProductRevenue += p.devProductRevenue
      out.gamePassRevenue += p.gamePassRevenue
      out.devProductSales += p.devProductSales
      out.gamePassSales += p.gamePassSales
      out.trackedVisits += p.trackedVisits
      out.peakCcu = Math.max(out.peakCcu, p.peakCcu)
      out.trackedMinutes += p.trackedMinutes
      out.sessionsEnded += p.sessionsEnded
      if (p.avgCcu !== null) ccuWeighted += p.avgCcu * p.trackedMinutes
      if (p.avgSessionSec !== null) sessionWeighted += p.avgSessionSec * p.sessionsEnded
      if (p.officialNewVisits !== null) {
        out.officialNewVisits = (out.officialNewVisits ?? 0) + p.officialNewVisits
        officialKnown = true
      }
      if (p.trackedMinutes > 0 || p.sales > 0) out.daysWithData += 1
    }
    if (!officialKnown) out.officialNewVisits = null
    out.avgCcu = out.trackedMinutes > 0 ? ccuWeighted / out.trackedMinutes : null
    out.avgSessionSec = out.sessionsEnded > 0 ? sessionWeighted / out.sessionsEnded : null
    // Distinct counts are not additive across days: query them directly.
    const src = sourceFilter(this.mode)
    const distinct = await this.cached(`sum:distinct:${fromDay}:${toDay}:${Math.floor(endMs / 300_000)}`, 60_000, async () => {
      const [players, payers] = await this.db.batch([
        partialLast
          ? this.db.prepare(
              `SELECT COUNT(DISTINCT user_id) AS c FROM player_sessions WHERE ${src} AND started_at >= ? AND started_at < ?`,
              startMs - 86_400_000,
              endMs,
            )
          : this.db.prepare(`SELECT COUNT(DISTINCT user_id) AS c FROM daily_players WHERE tz = ? AND day >= ? AND day <= ? AND ${src}`, tz, fromDay, toDay),
        this.db.prepare(`SELECT COUNT(DISTINCT user_id) AS c FROM purchases WHERE ${src} AND purchased_at >= ? AND purchased_at < ? AND user_id IS NOT NULL`, startMs, endMs),
      ])
      return { players: Number((players.results?.[0] as { c: number })?.c ?? 0), payers: Number((payers.results?.[0] as { c: number })?.c ?? 0) }
    })
    out.uniquePlayers = distinct.players
    out.payingPlayers = distinct.payers
    return out
  }

  private async summary(url: URL) {
    const range = this.parseRange(url)
    const current = await this.totalsFor(range.fromDay, range.toDay, range.startMs, range.endMs)
    let previous: (WindowTotals & { days: number; daysWithData: number }) | null = null
    if (range.prev) {
      const p = range.prev
      if (range.preset === 'today') {
        previous = {
          ...(await this.cached(`sum:prevtoday:${Math.floor(p.endMs / 60_000)}`, 60_000, () =>
            computeWindow(this.db, this.mode, p.startMs, p.endMs, { tz: this.config.timezone, firstTrackedAt: this.meta.firstTrackedAt }),
          )),
          days: 1,
          daysWithData: 0,
        }
        previous.daysWithData = previous.trackedMinutes > 0 || previous.sales > 0 ? 1 : 0
      } else {
        previous = await this.totalsFor(p.fromDay, p.toDay, p.startMs, p.endMs)
      }
      if (this.meta.firstTrackedAt === null || p.endMs <= this.meta.firstTrackedAt) previous.daysWithData = 0
    }
    const daily = range.preset === 'today' ? [] : await this.rangeDaily(range.fromDay, range.toDay)
    return {
      range,
      current,
      previous,
      daily,
      firstTrackedAt: this.meta.firstTrackedAt,
      netRevenueRate: this.config.netRevenueRate,
      generatedAt: Date.now(),
    }
  }

  private async seriesCcu(url: URL) {
    const windows: Record<string, [number, number]> = {
      '5m': [5 * 60_000, 60_000],
      '15m': [15 * 60_000, 60_000],
      '1h': [3_600_000, 60_000],
      '6h': [6 * 3_600_000, 5 * 60_000],
      '24h': [24 * 3_600_000, 10 * 60_000],
      '7d': [7 * 86_400_000, 60 * 60_000],
    }
    const w = url.searchParams.get('window') ?? '1h'
    const spec = windows[w]
    if (!spec) throw new HttpError(400, 'Unknown window')
    const now = Date.now()
    const ttl = spec[1] <= 60_000 ? 15_000 : 60_000
    const points = await this.cached(`ccu:${w}:${Math.floor(now / ttl)}`, ttl, () => ccuSeries(this.db, this.mode, now - spec[0], now, spec[1]))
    return { window: w, bucketMs: spec[1], points, firstTrackedAt: this.meta.firstTrackedAt, live: { t: now, ccu: this.currentCcu() } }
  }

  private async seriesRevenue(url: URL) {
    const range = this.parseRange(url)
    const hours = (range.endMs - range.startMs) / 3_600_000
    const tz = this.config.timezone
    if (hours <= 72) {
      const buckets = await this.cached(`rev:h:${range.startMs}:${Math.floor(range.endMs / 30_000)}`, 30_000, () =>
        revenueHourly(this.db, this.mode, range.startMs, range.endMs, tz),
      )
      return { granularity: 'hour', range, buckets, firstTrackedAt: this.meta.firstTrackedAt }
    }
    const daily = await this.rangeDaily(range.fromDay, range.toDay)
    return {
      granularity: 'day',
      range,
      buckets: daily.map((d) => ({ t: dayStartUtc(d.day, tz), day: d.day, revenue: d.revenue, sales: d.sales, devProductRevenue: d.devProductRevenue, gamePassRevenue: d.gamePassRevenue })),
      firstTrackedAt: this.meta.firstTrackedAt,
    }
  }

  private async seriesVisits(url: URL) {
    const range = this.parseRange(url)
    const hours = (range.endMs - range.startMs) / 3_600_000
    const tz = this.config.timezone
    if (hours <= 72) {
      const buckets = await this.cached(`vis:h:${range.startMs}:${Math.floor(range.endMs / 60_000)}`, 60_000, () =>
        visitsHourly(this.db, this.mode, range.startMs, range.endMs, tz),
      )
      return { granularity: 'hour', range, buckets, firstTrackedAt: this.meta.firstTrackedAt }
    }
    const daily = await this.rangeDaily(range.fromDay, range.toDay)
    return {
      granularity: 'day',
      range,
      buckets: daily.map((d) => ({ t: dayStartUtc(d.day, tz), day: d.day, tracked: d.trackedVisits, official: d.officialNewVisits, uniquePlayers: d.uniquePlayers })),
      firstTrackedAt: this.meta.firstTrackedAt,
    }
  }

  private async products_(url: URL) {
    const range = this.parseRange(url)
    const rows = await this.cached(`rev:prod:${range.startMs}:${Math.floor(range.endMs / 30_000)}`, 30_000, () =>
      productBreakdown(this.db, this.mode, range.startMs, range.endMs),
    )
    return { range, products: rows }
  }

  private async activityRows(opts: { limit: number; before?: number; categories: string[] | null; includeTest: boolean }): Promise<ActivityEvent[]> {
    const where: string[] = []
    const params: unknown[] = []
    if (opts.before) {
      where.push('seq < ?')
      params.push(opts.before)
    }
    if (opts.categories?.length) {
      where.push(`category IN (${opts.categories.map(() => '?').join(',')})`)
      params.push(...opts.categories)
    }
    if (!opts.includeTest) where.push(sourceFilter(this.mode))
    const rows = await this.db.all<{ seq: number; type: ActivityType; category: ActivityEvent['category']; occurred_at: number; data: string; source: DataOrigin }>(
      `SELECT seq, type, category, occurred_at, data, source FROM activity_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`,
      ...params,
      opts.limit,
    )
    return rows.map(rowToEvent)
  }

  private async activity(url: URL) {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
    const before = Number(url.searchParams.get('before')) || undefined
    const allowed = ['players', 'sales', 'servers', 'milestones']
    const cats = (url.searchParams.get('categories') ?? '').split(',').filter((c) => allowed.includes(c))
    const includeTest = url.searchParams.get('includeTest') === '1'
    const events = await this.activityRows({ limit, before, categories: cats.length ? cats : null, includeTest })
    return { events, hasMore: events.length === limit }
  }

  private async insights() {
    const tz = this.config.timezone
    return this.cached('rev:insights', 30_000, async () => {
      const src = sourceFilter(this.mode)
      const today = this.meta.today
      const [best, top, serverStats] = await this.db.batch([
        this.db.prepare(`SELECT day, revenue_robux FROM daily_aggregates WHERE tz = ? AND day < ? ORDER BY revenue_robux DESC, day DESC LIMIT 1`, tz, today.dayKey),
        this.db.prepare(
          `SELECT p.kind AS kind, p.product_id AS product_id, COALESCE(pr.name, MAX(p.product_name)) AS name, COUNT(*) AS sales, SUM(p.robux) AS revenue
           FROM purchases p LEFT JOIN products pr ON pr.kind = p.kind AND pr.product_id = p.product_id
           WHERE ${sourceFilter(this.mode, 'p.source')} AND p.purchased_at >= ? GROUP BY p.kind, p.product_id ORDER BY sales DESC LIMIT 5`,
          Date.now() - 30 * 86_400_000,
        ),
        this.db.prepare(
          `SELECT COUNT(*) AS c, AVG((COALESCE(ended_at, ?1) - started_at) / 1000.0) AS uptime,
                  SUM(CASE WHEN end_reason = 'heartbeat_timeout' THEN 1 ELSE 0 END) AS crashes
           FROM server_sessions WHERE ${src} AND started_at >= ?2`,
          Date.now(),
          Date.now() - 7 * 86_400_000,
        ),
      ])
      const b = best.results?.[0] as { day: string; revenue_robux: number } | undefined
      let highest = b ? { day: b.day, revenue: b.revenue_robux } : null
      if (today.revenue > 0 && (!highest || today.revenue > highest.revenue)) highest = { day: today.dayKey, revenue: today.revenue }
      const s = serverStats.results?.[0] as { c: number; uptime: number | null; crashes: number } | undefined
      return {
        highestEarningDay: highest,
        bestSellers: (top.results ?? []) as { kind: string; product_id: number; name: string | null; sales: number; revenue: number }[],
        servers7d: { count: s?.c ?? 0, avgUptimeSec: s?.uptime ?? null, heartbeatTimeouts: s?.crashes ?? 0 },
      }
    })
  }

  private async exportCsv(url: URL): Promise<Response> {
    const kind = url.searchParams.get('kind') ?? 'purchases'
    const range = this.parseRange(url)
    const src = sourceFilter(this.mode)
    const tz = this.config.timezone
    const iso = (ms: unknown) => (typeof ms === 'number' ? new Date(ms).toISOString() : '')
    let header: string[]
    let rows: unknown[][]
    const LIMIT = 20_000
    if (kind === 'purchases') {
      header = ['purchased_at_utc', 'local_day', 'kind', 'product_id', 'product_name', 'robux', 'amount_source', 'user_id', 'username', 'dedupe_key', 'job_id']
      const r = await this.db.all<Record<string, unknown>>(
        `SELECT * FROM purchases WHERE ${src} AND purchased_at >= ? AND purchased_at < ? ORDER BY purchased_at LIMIT ${LIMIT}`,
        range.startMs,
        range.endMs,
      )
      rows = r.map((p) => [iso(p.purchased_at), dayKey(Number(p.purchased_at), tz), p.kind, p.product_id, p.product_name, p.robux, p.amount_source, p.user_id, p.username, p.dedupe_key, p.job_id])
    } else if (kind === 'daily') {
      header = ['day', 'timezone', 'revenue_robux', 'sales', 'dev_product_revenue', 'game_pass_revenue', 'tracked_visits', 'official_new_visits', 'unique_players', 'peak_ccu', 'avg_ccu', 'avg_session_sec', 'final']
      const d = await this.rangeDaily(range.fromDay, range.toDay)
      rows = d.map((x) => [x.day, tz, x.revenue, x.sales, x.devProductRevenue, x.gamePassRevenue, x.trackedVisits, x.officialNewVisits ?? '', x.uniquePlayers, x.peakCcu, x.avgCcu?.toFixed(2) ?? '', x.avgSessionSec?.toFixed(0) ?? '', x.finalized ? 'yes' : 'no'])
    } else if (kind === 'sessions') {
      header = ['started_at_utc', 'ended_at_utc', 'duration_sec', 'user_id', 'username', 'job_id', 'end_reason', 'join_source']
      const r = await this.db.all<Record<string, unknown>>(
        `SELECT * FROM player_sessions WHERE ${src} AND started_at >= ? AND started_at < ? ORDER BY started_at LIMIT ${LIMIT}`,
        range.startMs,
        range.endMs,
      )
      rows = r.map((s) => [iso(s.started_at), iso(s.ended_at), s.duration_sec ?? '', s.user_id, s.username, s.job_id, s.end_reason ?? '', s.join_source])
    } else {
      throw new HttpError(400, 'Unknown export kind')
    }
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="roadster-life-${kind}-${range.fromDay}_${range.toDay}.csv"`,
        'cache-control': 'no-store',
        'x-row-limit': String(LIMIT),
      },
    })
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  private async adminUsage(url: URL) {
    const now = Date.now()
    const accountId = this.env.CF_ACCOUNT_ID
    const token = this.env.CF_API_TOKEN
    if (accountId && token && (url.searchParams.get('refresh') === '1' || !this.cfUsage || now - this.cfUsage.fetchedAt > 15 * 60_000)) {
      this.cfUsage = await fetchCloudflareUsage(accountId, token, now)
    }
    return {
      report: usageReport(this.usageNow(), now),
      budget: this.budget(),
      cloudflare: accountId && token ? this.cfUsage : null,
      cloudflareConfigured: Boolean(accountId && token),
      viewers: this.viewerCount(),
      liveServers: this.liveServerCount(),
    }
  }

  private integration() {
    return {
      servers: [...this.servers.values()].map((s) => ({ jobId: s.jobId, source: s.source, players: Object.keys(s.players).length, lastSeenAt: s.lastSeenAt, startedAt: s.startedAt, heartbeatSec: s.heartbeatSec, placeVersion: s.placeVersion })),
      recentBatches: this.ingestLog,
      ingestSecretConfigured: secretStatus(this.env).INGEST_SECRET,
      requireHmac: this.env.INGEST_REQUIRE_HMAC === 'true',
      universeId: this.config.universeId,
    }
  }

  private health() {
    const now = Date.now()
    return {
      ok: true,
      serverTime: now,
      mode: this.mode,
      ingest: this.liveSnapshot(now).ingest,
      official: this.officialMetrics(now),
      viewers: this.viewerCount(),
      alarmAt: this.alarmAt,
      budget: this.budget(),
    }
  }

  private async updateConfig(body: Record<string, unknown>) {
    let next: AppConfig
    try {
      next = applyConfigPatch(this.config, body)
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
    const now = Date.now()
    const changed = CONFIG_KEYS.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(this.config[k]))
    if (!changed.length) return { ok: true, config: this.publicConfig() }
    await this.db.batch(
      changed.map((k) =>
        this.db.prepare(
          `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          k,
          JSON.stringify(next[k]),
          now,
        ),
      ),
    )
    const tzChanged = next.timezone !== this.config.timezone
    const universeChanged = next.universeId !== this.config.universeId
    this.config = next
    await this.ctx.storage.put('config', next)
    this.usageNow().doStorage.writes += 1
    if (tzChanged) {
      this.meta.tz = next.timezone
      this.meta.today = emptyToday(dayKey(now, next.timezone))
      this.meta.official.baseline = null
      await this.recomputeToday(now)
      this.meta.backfillCursor = addDays(this.meta.today.dayKey, -1)
      this.cache.clear()
    }
    if (universeChanged) {
      this.meta.official = { ...this.meta.official, visits: null, playing: null, favorites: null, name: null, fetchedAt: null, baseline: null, failures: 0, lastError: null, nextPollAt: now }
      await this.pollOfficial(now, false)
    }
    this.metaDirty = true
    this.broadcastLive()
    return { ok: true, config: this.publicConfig() }
  }

  private async updateProducts(body: Record<string, unknown>) {
    const list = body.products
    if (!Array.isArray(list) || list.length > 500) throw new HttpError(400, 'products must be an array (max 500)')
    const clean: ProductConfig[] = []
    for (const p of list as Record<string, unknown>[]) {
      const kind = p.kind
      const id = Number(p.productId)
      if ((kind !== 'developer_product' && kind !== 'game_pass') || !Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Each product needs a kind and a numeric ID')
      const name = typeof p.name === 'string' ? p.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80) || null : null
      const price = p.priceRobux === null || p.priceRobux === undefined || p.priceRobux === '' ? null : Number(p.priceRobux)
      if (price !== null && (!Number.isInteger(price) || price < 0)) throw new HttpError(400, 'Price must be a whole number of Robux')
      clean.push({ kind, productId: id, name, priceRobux: price })
    }
    const now = Date.now()
    const keep = new Set(clean.map((p) => `${p.kind}:${p.productId}`))
    const removed = [...this.products.values()].filter((p) => !keep.has(`${p.kind}:${p.productId}`))
    await this.db.batch([
      ...removed.map((p) => this.db.prepare(`DELETE FROM products WHERE kind = ? AND product_id = ?`, p.kind, p.productId)),
      ...clean.map((p) =>
        this.db.prepare(
          `INSERT INTO products (kind, product_id, name, price_robux, configured, info_source, updated_at) VALUES (?, ?, ?, ?, 1, 'owner', ?)
           ON CONFLICT (kind, product_id) DO UPDATE SET name = COALESCE(excluded.name, products.name), price_robux = COALESCE(excluded.price_robux, products.price_robux),
             configured = 1, updated_at = excluded.updated_at`,
          p.kind,
          p.productId,
          p.name,
          p.priceRobux,
          now,
        ),
      ),
    ])
    await this.reloadConfigFromD1()
    this.invalidate('rev')
    return { ok: true, config: this.publicConfig() }
  }

  private async lookupUniverse(body: Record<string, unknown>) {
    const placeId = String(body.placeId ?? '').trim()
    try {
      this.usageNow().roblox.requests += 1
      return { ok: true, placeId, universeId: await lookupUniverseId(placeId) }
    } catch (err) {
      throw new HttpError(502, (err as Error).message)
    }
  }

  private async verifyOpenCloud() {
    const key = this.env.ROBLOX_OPEN_CLOUD_API_KEY
    if (!key) throw new HttpError(400, 'ROBLOX_OPEN_CLOUD_API_KEY secret is not set')
    if (!this.config.universeId) throw new HttpError(400, 'Set the Universe ID first')
    try {
      this.usageNow().roblox.requests += 1
      return { ok: true, universe: await verifyOpenCloudKey(this.config.universeId, key) }
    } catch (err) {
      throw new HttpError(502, `Open Cloud check failed: ${(err as Error).message}`)
    }
  }

  private async adminRecompute(body: Record<string, unknown>) {
    const now = Date.now()
    const day = body.day
    if (day !== undefined && !isDayKey(day)) throw new HttpError(400, 'day must be YYYY-MM-DD')
    if (typeof day === 'string' && day !== this.meta.today.dayKey) {
      await recomputeDay(this.db, this.mode, this.config.timezone, day, this.meta.firstTrackedAt, now)
    } else {
      await this.recomputeToday(now)
      await this.recomputeAllTime()
      await recomputeDay(this.db, this.mode, this.config.timezone, this.meta.today.dayKey, this.meta.firstTrackedAt, now)
    }
    this.cache.clear()
    this.broadcastLive()
    return { ok: true, today: this.liveSnapshot(now).today }
  }

  /**
   * Development-only generator. Every generated row is stored with
   * source = 'synthetic' and is rejected outright in production mode.
   */
  private async synthetic(body: Record<string, unknown>) {
    if (this.mode !== 'development') throw new HttpError(403, 'Synthetic test events are disabled in production mode')
    const action = String(body.action ?? '')
    const now = Date.now()
    const jobId = 'synthetic-test-server'
    const srv = this.servers.get(jobId)
    const roster = srv ? Object.entries(srv.players).map(([u, p]) => ({ u: Number(u), j: p.j, n: p.n })) : []
    const batch: IngestBatch = {
      v: 1,
      batchId: crypto.randomUUID(),
      sentAt: now,
      synthetic: true,
      server: { jobId, placeId: Number(this.config.placeId) || 1, startedAt: srv?.startedAt ?? now },
      events: [],
    }
    const fakeUser = () => 1_000_000_000 + Math.floor(Math.random() * 1_000_000)
    switch (action) {
      case 'join': {
        const u = fakeUser()
        batch.events!.push({ type: 'join', u, j: now, n: `TestPlayer${u % 10000}` })
        break
      }
      case 'leave': {
        const p = roster[0]
        if (!p) throw new HttpError(400, 'No synthetic players to remove')
        batch.events!.push({ type: 'leave', u: p.u, j: p.j, at: now })
        break
      }
      case 'purchase': {
        const p = roster[0] ?? { u: fakeUser(), j: now }
        const product = [...this.products.values()].find((x) => x.kind === 'developer_product')
        batch.events!.push({
          type: 'purchase',
          kind: 'developer_product',
          productId: product?.productId ?? 1,
          productName: product?.name ?? 'Synthetic Test Product',
          robux: product?.priceRobux ?? 49,
          u: p.u,
          at: now,
          purchaseId: `synthetic-${crypto.randomUUID()}`,
        })
        break
      }
      case 'close':
        batch.events!.push({ type: 'server_close', at: now })
        break
      default:
        throw new HttpError(400, 'action must be join, leave, purchase or close')
    }
    return this.ingest(batch, now)
  }
}

function rowToEvent(r: { seq: number; type: ActivityType; category: ActivityEvent['category']; occurred_at: number; data: string; source: DataOrigin }): ActivityEvent {
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(r.data)
  } catch {
    // keep empty
  }
  return { seq: r.seq, type: r.type, category: r.category, at: r.occurred_at, source: r.source, data }
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  let s = String(v)
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (!text) return {}
  if (text.length > 64 * 1024) throw new HttpError(413, 'Body too large')
  try {
    const v = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object')
    return v as Record<string, unknown>
  } catch {
    throw new HttpError(400, 'Body must be a JSON object')
  }
}
