import { HOUR, dayRangeUtc, hourBucketStart, tzOffsetMs } from '../shared/time'
import { sourceFilter, type Db } from './db'

type Mode = 'production' | 'development'

export interface WindowTotals {
  revenue: number
  sales: number
  devProductRevenue: number
  devProductSales: number
  gamePassRevenue: number
  gamePassSales: number
  trackedVisits: number
  uniquePlayers: number
  payingPlayers: number
  peakCcu: number
  avgCcu: number | null
  trackedMinutes: number
  ccuMinuteSum: number
  sessionsEnded: number
  sessionSecondsTotal: number
  avgSessionSec: number | null
  officialVisitsStart: number | null
  officialVisitsEnd: number | null
  officialNewVisits: number | null
}

export function emptyTotals(): WindowTotals {
  return {
    revenue: 0,
    sales: 0,
    devProductRevenue: 0,
    devProductSales: 0,
    gamePassRevenue: 0,
    gamePassSales: 0,
    trackedVisits: 0,
    uniquePlayers: 0,
    payingPlayers: 0,
    peakCcu: 0,
    avgCcu: null,
    trackedMinutes: 0,
    ccuMinuteSum: 0,
    sessionsEnded: 0,
    sessionSecondsTotal: 0,
    avgSessionSec: null,
    officialVisitsStart: null,
    officialVisitsEnd: null,
    officialNewVisits: null,
  }
}

type Row = Record<string, number | string | null>
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const nn = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Computes authoritative totals for [startMs, endMs) straight from the raw tables.
 * When `fullDay` is given the exact per-day unique-player table is used.
 */
export async function computeWindow(
  db: Db,
  mode: Mode,
  startMs: number,
  endMs: number,
  opts: { tz: string; fullDay?: string; firstTrackedAt: number | null },
): Promise<WindowTotals> {
  const src = sourceFilter(mode)
  const stmts = [
    db.prepare(
      `SELECT kind, COUNT(*) AS c, COALESCE(SUM(robux),0) AS r FROM purchases WHERE ${src} AND purchased_at >= ? AND purchased_at < ? GROUP BY kind`,
      startMs,
      endMs,
    ),
    db.prepare(`SELECT COUNT(*) AS c FROM player_sessions WHERE ${src} AND started_at >= ? AND started_at < ?`, startMs, endMs),
    db.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(duration_sec),0) AS s FROM player_sessions WHERE ${src} AND ended_at >= ? AND ended_at < ?`,
      startMs,
      endMs,
    ),
    opts.fullDay
      ? db.prepare(`SELECT COUNT(*) AS c FROM daily_players WHERE tz = ? AND day = ? AND ${src}`, opts.tz, opts.fullDay)
      : db.prepare(
          `SELECT COUNT(DISTINCT user_id) AS c FROM player_sessions WHERE ${src} AND started_at >= ? AND started_at < ? AND (ended_at IS NULL OR ended_at >= ?)`,
          startMs - 86_400_000,
          endMs,
          startMs,
        ),
    db.prepare(
      `SELECT MAX(tracked_max) AS peak, COALESCE(SUM(tracked_ccu),0) AS s, COUNT(*) AS c FROM ccu_snapshots WHERE ${src} AND minute_at >= ? AND minute_at < ?`,
      startMs,
      endMs,
    ),
    db.prepare(`SELECT visits FROM official_snapshots WHERE fetched_at < ? AND visits IS NOT NULL ORDER BY fetched_at DESC LIMIT 1`, startMs),
    db.prepare(
      `SELECT visits FROM official_snapshots WHERE fetched_at >= ? AND fetched_at < ? AND visits IS NOT NULL ORDER BY fetched_at ASC LIMIT 1`,
      startMs,
      endMs,
    ),
    db.prepare(`SELECT visits FROM official_snapshots WHERE fetched_at < ? AND visits IS NOT NULL ORDER BY fetched_at DESC LIMIT 1`, endMs),
    db.prepare(
      `SELECT COUNT(DISTINCT user_id) AS c FROM purchases WHERE ${src} AND purchased_at >= ? AND purchased_at < ? AND user_id IS NOT NULL`,
      startMs,
      endMs,
    ),
  ]
  const res = await db.batch(stmts)
  const rows = (i: number) => (res[i].results ?? []) as Row[]
  const t = emptyTotals()
  for (const r of rows(0)) {
    if (r.kind === 'developer_product') {
      t.devProductRevenue = n(r.r)
      t.devProductSales = n(r.c)
    } else if (r.kind === 'game_pass') {
      t.gamePassRevenue = n(r.r)
      t.gamePassSales = n(r.c)
    }
  }
  t.revenue = t.devProductRevenue + t.gamePassRevenue
  t.sales = t.devProductSales + t.gamePassSales
  t.trackedVisits = n(rows(1)[0]?.c)
  t.sessionsEnded = n(rows(2)[0]?.c)
  t.sessionSecondsTotal = n(rows(2)[0]?.s)
  t.avgSessionSec = t.sessionsEnded > 0 ? t.sessionSecondsTotal / t.sessionsEnded : null
  t.uniquePlayers = n(rows(3)[0]?.c)
  t.peakCcu = n(rows(4)[0]?.peak)
  t.ccuMinuteSum = n(rows(4)[0]?.s)
  const coveredFrom = Math.max(startMs, opts.firstTrackedAt ?? Number.POSITIVE_INFINITY)
  t.trackedMinutes = coveredFrom < endMs ? Math.max(1, Math.round((endMs - coveredFrom) / 60_000)) : 0
  // Minutes without a snapshot are minutes with no live servers (0 players).
  t.avgCcu = t.trackedMinutes > 0 ? t.ccuMinuteSum / t.trackedMinutes : null
  t.officialVisitsStart = nn(rows(5)[0]?.visits) ?? nn(rows(6)[0]?.visits)
  t.officialVisitsEnd = nn(rows(7)[0]?.visits)
  t.officialNewVisits =
    t.officialVisitsStart !== null && t.officialVisitsEnd !== null ? Math.max(0, t.officialVisitsEnd - t.officialVisitsStart) : null
  t.payingPlayers = n(rows(8)[0]?.c)
  return t
}

/** Recomputes one reporting day from raw rows and upserts it (idempotent). */
export async function recomputeDay(
  db: Db,
  mode: Mode,
  tz: string,
  day: string,
  firstTrackedAt: number | null,
  now: number,
): Promise<WindowTotals> {
  const [start, end] = dayRangeUtc(day, tz)
  const t = await computeWindow(db, mode, start, Math.min(end, now), { tz, fullDay: day, firstTrackedAt })
  await db.run(
    `INSERT INTO daily_aggregates (tz, day, revenue_robux, sales_count, dev_product_revenue, dev_product_sales, game_pass_revenue, game_pass_sales,
       tracked_visits, unique_players, peak_ccu, avg_ccu, sessions_ended, avg_session_sec, official_visits_start, official_visits_end,
       tracked_minutes, finalized, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tz, day) DO UPDATE SET
       revenue_robux = excluded.revenue_robux, sales_count = excluded.sales_count,
       dev_product_revenue = excluded.dev_product_revenue, dev_product_sales = excluded.dev_product_sales,
       game_pass_revenue = excluded.game_pass_revenue, game_pass_sales = excluded.game_pass_sales,
       tracked_visits = excluded.tracked_visits, unique_players = excluded.unique_players,
       peak_ccu = excluded.peak_ccu, avg_ccu = excluded.avg_ccu, sessions_ended = excluded.sessions_ended,
       avg_session_sec = excluded.avg_session_sec, official_visits_start = excluded.official_visits_start,
       official_visits_end = excluded.official_visits_end, tracked_minutes = excluded.tracked_minutes,
       finalized = excluded.finalized, updated_at = excluded.updated_at`,
    tz,
    day,
    t.revenue,
    t.sales,
    t.devProductRevenue,
    t.devProductSales,
    t.gamePassRevenue,
    t.gamePassSales,
    t.trackedVisits,
    t.uniquePlayers,
    t.peakCcu,
    t.avgCcu,
    t.sessionsEnded,
    t.avgSessionSec,
    t.officialVisitsStart,
    t.officialVisitsEnd,
    t.trackedMinutes,
    end <= now ? 1 : 0,
    now,
  )
  return t
}

export interface DailyRow {
  day: string
  revenue: number
  sales: number
  devProductRevenue: number
  gamePassRevenue: number
  trackedVisits: number
  uniquePlayers: number
  peakCcu: number
  avgCcu: number | null
  avgSessionSec: number | null
  sessionsEnded: number
  trackedMinutes: number
  officialNewVisits: number | null
  finalized: boolean
}

export async function dailyRows(db: Db, tz: string, fromDay: string, toDay: string): Promise<DailyRow[]> {
  const rows = await db.all<Row>(
    `SELECT * FROM daily_aggregates WHERE tz = ? AND day >= ? AND day <= ? ORDER BY day`,
    tz,
    fromDay,
    toDay,
  )
  return rows.map(toDailyRow)
}

export function toDailyRow(r: Row): DailyRow {
  const start = nn(r.official_visits_start)
  const end = nn(r.official_visits_end)
  return {
    day: String(r.day),
    revenue: n(r.revenue_robux),
    sales: n(r.sales_count),
    devProductRevenue: n(r.dev_product_revenue),
    gamePassRevenue: n(r.game_pass_revenue),
    trackedVisits: n(r.tracked_visits),
    uniquePlayers: n(r.unique_players),
    peakCcu: n(r.peak_ccu),
    avgCcu: nn(r.avg_ccu),
    avgSessionSec: nn(r.avg_session_sec),
    sessionsEnded: n(r.sessions_ended),
    trackedMinutes: n(r.tracked_minutes),
    officialNewVisits: start !== null && end !== null ? Math.max(0, end - start) : null,
    finalized: n(r.finalized) === 1,
  }
}

export function dailyRowFromTotals(day: string, t: WindowTotals, finalized: boolean): DailyRow {
  return {
    day,
    revenue: t.revenue,
    sales: t.sales,
    devProductRevenue: t.devProductRevenue,
    gamePassRevenue: t.gamePassRevenue,
    trackedVisits: t.trackedVisits,
    uniquePlayers: t.uniquePlayers,
    peakCcu: t.peakCcu,
    avgCcu: t.avgCcu,
    avgSessionSec: t.avgSessionSec,
    sessionsEnded: t.sessionsEnded,
    trackedMinutes: t.trackedMinutes,
    officialNewVisits: t.officialNewVisits,
    finalized,
  }
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export interface CcuPoint {
  t: number
  ccu: number
  max: number
  servers: number
  official: number | null
}

export async function ccuSeries(db: Db, mode: Mode, fromMs: number, toMs: number, bucketMs: number): Promise<CcuPoint[]> {
  const rows = await db.all<Row>(
    `SELECT (minute_at / ?1) * ?1 AS t, AVG(tracked_ccu) AS ccu, MAX(tracked_max) AS mx, MAX(servers) AS sv, AVG(official_ccu) AS oc
     FROM ccu_snapshots WHERE minute_at >= ?2 AND minute_at < ?3 AND ${sourceFilter(mode)}
     GROUP BY t ORDER BY t`,
    bucketMs,
    fromMs,
    toMs,
  )
  return rows.map((r) => ({ t: n(r.t), ccu: Math.round(n(r.ccu) * 10) / 10, max: n(r.mx), servers: n(r.sv), official: nn(r.oc) === null ? null : Math.round(n(r.oc)) }))
}

export interface HourBucket {
  t: number
  revenue: number
  sales: number
  devProductRevenue: number
  gamePassRevenue: number
}

/** Hourly revenue buckets in the reporting timezone (empty hours included). */
export async function revenueHourly(db: Db, mode: Mode, startMs: number, endMs: number, tz: string): Promise<HourBucket[]> {
  const rows = await db.all<Row>(
    `SELECT purchased_at, robux, kind FROM purchases WHERE ${sourceFilter(mode)} AND purchased_at >= ? AND purchased_at < ? ORDER BY purchased_at`,
    startMs,
    endMs,
  )
  const buckets = hourSkeleton(startMs, endMs, tz, () => ({ revenue: 0, sales: 0, devProductRevenue: 0, gamePassRevenue: 0 }))
  for (const r of rows) {
    const b = buckets.get(hourBucketStart(n(r.purchased_at), tz))
    if (!b) continue
    b.revenue += n(r.robux)
    b.sales += 1
    if (r.kind === 'game_pass') b.gamePassRevenue += n(r.robux)
    else b.devProductRevenue += n(r.robux)
  }
  return [...buckets.entries()].map(([t, v]) => ({ t, ...v }))
}

export interface VisitBucket {
  t: number
  tracked: number
  official: number | null
}

export async function visitsHourly(db: Db, mode: Mode, startMs: number, endMs: number, tz: string): Promise<VisitBucket[]> {
  // Shift by the sub-hour part of the UTC offset so buckets align to local clock hours.
  const offMod = ((tzOffsetMs(startMs, tz) % HOUR) + HOUR) % HOUR
  const [tracked, official] = await Promise.all([
    db.all<Row>(
      `SELECT ((started_at + ?1) / 3600000) * 3600000 - ?1 AS h, COUNT(*) AS c FROM player_sessions
       WHERE ${sourceFilter(mode)} AND started_at >= ?2 AND started_at < ?3 GROUP BY h`,
      offMod,
      startMs,
      endMs,
    ),
    db.all<Row>(
      `SELECT fetched_at, visits FROM official_snapshots WHERE fetched_at >= ? AND fetched_at < ? AND visits IS NOT NULL ORDER BY fetched_at`,
      startMs - 2 * HOUR,
      endMs,
    ),
  ])
  const buckets = hourSkeleton(startMs, endMs, tz, () => ({ tracked: 0, official: null as number | null }))
  for (const r of tracked) {
    const b = buckets.get(hourBucketStart(n(r.h), tz))
    if (b) b.tracked += n(r.c)
  }
  // Official visits per hour = last counter value in the hour − last value before it.
  let prev: number | null = null
  let prevBucket: number | null = null
  const lastInBucket = new Map<number, number>()
  const firstPrev = new Map<number, number | null>()
  for (const r of official) {
    const t = n(r.fetched_at)
    const v = n(r.visits)
    const b = hourBucketStart(t, tz)
    if (b !== prevBucket) {
      firstPrev.set(b, prev)
      prevBucket = b
    }
    lastInBucket.set(b, v)
    prev = v
  }
  for (const [t, b] of buckets) {
    const last = lastInBucket.get(t)
    const before = firstPrev.get(t)
    if (last !== undefined && before !== undefined && before !== null) b.official = Math.max(0, last - before)
  }
  return [...buckets.entries()].map(([t, v]) => ({ t, ...v }))
}

function hourSkeleton<T>(startMs: number, endMs: number, tz: string, make: () => T): Map<number, T> {
  const out = new Map<number, T>()
  let t = hourBucketStart(startMs, tz)
  let guard = 0
  while (t < endMs && guard++ < 24 * 62) {
    out.set(t, make())
    t = hourBucketStart(t + HOUR + 60_000, tz)
  }
  return out
}

export interface ProductRow {
  kind: string
  productId: number
  name: string | null
  revenue: number
  sales: number
  buyers: number
  lastSoldAt: number
}

export async function productBreakdown(db: Db, mode: Mode, startMs: number, endMs: number): Promise<ProductRow[]> {
  const rows = await db.all<Row>(
    `SELECT p.kind AS kind, p.product_id AS product_id, COALESCE(pr.name, MAX(p.product_name)) AS name,
            SUM(p.robux) AS revenue, COUNT(*) AS sales, COUNT(DISTINCT p.user_id) AS buyers, MAX(p.purchased_at) AS last_at
     FROM purchases p LEFT JOIN products pr ON pr.kind = p.kind AND pr.product_id = p.product_id
     WHERE ${sourceFilter(mode, 'p.source')} AND p.purchased_at >= ? AND p.purchased_at < ?
     GROUP BY p.kind, p.product_id ORDER BY revenue DESC LIMIT 200`,
    startMs,
    endMs,
  )
  return rows.map((r) => ({
    kind: String(r.kind),
    productId: n(r.product_id),
    name: typeof r.name === 'string' ? r.name : null,
    revenue: n(r.revenue),
    sales: n(r.sales),
    buyers: n(r.buyers),
    lastSoldAt: n(r.last_at),
  }))
}
