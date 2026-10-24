import type { BudgetStatus } from '../shared/types'

// Cloudflare Workers Free plan allowances (daily, reset 00:00 UTC). Sources:
// developers.cloudflare.com/workers/platform/limits, /durable-objects/platform/pricing,
// /d1/platform/pricing. Re-check them if Cloudflare changes its plans.
export const FREE_LIMITS = {
  workerRequests: 100_000,
  doRequests: 100_000,
  doDurationGbSec: 13_000,
  d1RowsRead: 5_000_000,
  d1RowsWritten: 100_000,
  // Incoming WebSocket messages are billed 20:1 as Durable Object requests.
  wsMessagesPerRequest: 20,
} as const

export interface UsageCounters {
  day: string // UTC day — Cloudflare's free-tier counters reset at 00:00 UTC
  startedAt: number
  worker: { ingest: number; api: number; ws: number; login: number; cron: number; rejected: number }
  doRequests: { fetch: number; alarm: number }
  wsMessagesIn: number
  d1: { rowsRead: number; rowsWritten: number; queries: number }
  doStorage: { reads: number; writes: number }
  roblox: { requests: number; errors: number; rateLimited: number }
  ingest: { batches: number; events: number; duplicates: number; rejected: number }
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function emptyUsage(now: number): UsageCounters {
  return {
    day: utcDay(now),
    startedAt: now,
    worker: { ingest: 0, api: 0, ws: 0, login: 0, cron: 0, rejected: 0 },
    doRequests: { fetch: 0, alarm: 0 },
    wsMessagesIn: 0,
    d1: { rowsRead: 0, rowsWritten: 0, queries: 0 },
    doStorage: { reads: 0, writes: 0 },
    roblox: { requests: 0, errors: 0, rateLimited: 0 },
    ingest: { batches: 0, events: 0, duplicates: 0, rejected: 0 },
  }
}

export function workerRequestTotal(u: UsageCounters): number {
  const w = u.worker
  return w.ingest + w.api + w.ws + w.login + w.cron + w.rejected
}

export function doRequestTotal(u: UsageCounters): number {
  return u.doRequests.fetch + u.doRequests.alarm + Math.ceil(u.wsMessagesIn / FREE_LIMITS.wsMessagesPerRequest)
}

/** Linear projection of a counter to the end of the UTC day. */
export function projectDaily(used: number, now: number): number {
  const dayStart = Date.parse(`${utcDay(now)}T00:00:00Z`)
  const elapsed = Math.max(now - dayStart, 1)
  // Early in the day a linear projection is too noisy; assume at least 1h elapsed.
  return Math.round((used * 86_400_000) / Math.max(elapsed, 3_600_000))
}

export interface UsageReport {
  day: string
  resetsAt: number
  counters: UsageCounters
  metrics: {
    key: string
    label: string
    used: number
    limit: number
    projected: number
    pct: number
    projectedPct: number
    note: string
  }[]
}

export function usageReport(u: UsageCounters, now: number): UsageReport {
  const metric = (key: string, label: string, used: number, limit: number, note: string) => {
    const projected = projectDaily(used, now)
    return { key, label, used, limit, projected, pct: used / limit, projectedPct: projected / limit, note }
  }
  return {
    day: u.day,
    resetsAt: Date.parse(`${u.day}T00:00:00Z`) + 86_400_000,
    counters: u,
    metrics: [
      metric(
        'workerRequests',
        'Worker requests',
        workerRequestTotal(u),
        FREE_LIMITS.workerRequests,
        'Ingestion + API + WebSocket upgrades + cron. Static asset requests are not counted by Cloudflare.',
      ),
      metric(
        'doRequests',
        'Durable Object requests',
        doRequestTotal(u),
        FREE_LIMITS.doRequests,
        'Forwarded requests + alarms + incoming WebSocket messages ÷ 20. Auto-answered pings are excluded.',
      ),
      metric('d1RowsRead', 'D1 rows read', u.d1.rowsRead, FREE_LIMITS.d1RowsRead, 'Exact, summed from D1 query metadata.'),
      metric('d1RowsWritten', 'D1 rows written', u.d1.rowsWritten, FREE_LIMITS.d1RowsWritten, 'Exact, summed from D1 query metadata (index writes included).'),
    ],
  }
}

/**
 * Adaptive ingestion budget. The hub tells every Roblox server how often to send
 * heartbeats and how long to batch non-critical events, so total traffic stays
 * inside the free allowance as the number of servers grows. Purchases are
 * always sent immediately regardless of level.
 */
export function computeBudget(u: UsageCounters, liveServers: number, now: number): BudgetStatus {
  const messages: string[] = []
  const workerPct = projectDaily(workerRequestTotal(u), now) / FREE_LIMITS.workerRequests
  const usedPct = workerRequestTotal(u) / FREE_LIMITS.workerRequests
  const writePct = projectDaily(u.d1.rowsWritten, now) / FREE_LIMITS.d1RowsWritten
  const writeUsedPct = u.d1.rowsWritten / FREE_LIMITS.d1RowsWritten
  const worst = Math.max(workerPct, writePct)

  let level: BudgetStatus['level'] = 'ok'
  if (worst > 0.9 || usedPct > 0.85 || writeUsedPct > 0.85) level = 'critical'
  else if (worst > 0.7) level = 'elevated'

  // Keep heartbeat traffic alone under ~45% of the daily Worker allowance.
  const heartbeatFloor = Math.ceil((Math.max(liveServers, 1) * 86_400) / (FREE_LIMITS.workerRequests * 0.45))
  let heartbeatSec = Math.max(60, heartbeatFloor)
  let flushSec = 1
  let joinLeaveLogging = true
  let snapshotEverySec = 60
  if (level === 'elevated') {
    heartbeatSec = Math.max(heartbeatSec, 120)
    flushSec = 5
    messages.push('Projected usage is above 70% of the free allowance: heartbeats slowed and join/leave batching set to 5 s.')
  }
  if (level === 'critical') {
    heartbeatSec = Math.max(heartbeatSec, 300)
    flushSec = 15
    if (writePct > 0.9 || writeUsedPct > 0.85) {
      joinLeaveLogging = false
      snapshotEverySec = 120
      messages.push('D1 write budget is nearly exhausted: join/leave feed logging paused (sessions are still recorded).')
    }
    messages.push('Free-tier usage is critical: join/leave events are batched for 15 s. Purchases are still sent immediately.')
  }
  heartbeatSec = Math.min(heartbeatSec, 600)
  if (heartbeatFloor > 60 && level === 'ok') messages.push(`${liveServers} live servers: heartbeat interval raised to ${heartbeatSec} s to stay within the free plan.`)
  return { level, heartbeatSec, flushSec, joinLeaveLogging, snapshotEverySec, messages }
}
