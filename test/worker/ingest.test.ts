import { describe, expect, it } from 'vitest'
import { api, batch, db, ingest, ingestOk, jobId, live, uid } from '../helpers'

const purchase = (u: number, purchaseId: string, robux = 249, productId = 555) => ({
  type: 'purchase' as const,
  kind: 'developer_product' as const,
  productId,
  robux,
  u,
  at: Date.now(),
  purchaseId,
  productName: 'Nitro Boost',
})

describe('player joins and disconnects', () => {
  it('updates CCU immediately on join and leave and records session duration', async () => {
    const job = jobId()
    const u = uid()
    const j = Date.now() - 90_000
    const before = await live()
    await ingestOk(batch(job, { events: [{ type: 'join', u, j, n: 'Racer' }] }))
    expect((await live()).ccu).toBe(before.ccu + 1)
    await ingestOk(batch(job, { events: [{ type: 'leave', u, j, at: Date.now() }] }))
    const after = await live()
    expect(after.ccu).toBe(before.ccu)
    expect(after.today.sessionsEnded).toBe(before.today.sessionsEnded + 1)
    const row = await (await db()).prepare('SELECT duration_sec, end_reason FROM player_sessions WHERE session_id = ?').bind(`${job}:${u}:${j}`).first()
    expect(row).toMatchObject({ end_reason: 'left' })
    expect(Number(row?.duration_sec)).toBeGreaterThanOrEqual(89)
  })

  it('counts a repeated join report once', async () => {
    const job = jobId()
    const u = uid()
    const j = Date.now()
    const before = await live()
    await ingestOk(batch(job, { events: [{ type: 'join', u, j }] }))
    await ingestOk(batch(job, { events: [{ type: 'join', u, j }] }))
    const after = await live()
    expect(after.ccu).toBe(before.ccu + 1)
    expect(after.today.trackedVisits).toBe(before.today.trackedVisits + 1)
    expect(after.today.uniquePlayers).toBe(before.today.uniquePlayers + 1)
  })

  it('reconciles missed joins and missed leaves from the heartbeat roster', async () => {
    const job = jobId()
    const a = uid()
    const b = uid()
    const c = uid()
    const j = Date.now() - 5_000
    const before = await live()
    await ingestOk(batch(job, { events: [{ type: 'join', u: a, j }, { type: 'join', u: b, j }] }))
    // B's leave event was lost; C's join event was lost.
    await ingestOk(batch(job, { players: [{ u: a, j }, { u: c, j: j + 1000 }] }))
    const after = await live()
    expect(after.ccu).toBe(before.ccu + 2)
    const rows = await (await db())
      .prepare('SELECT user_id, ended_at, join_source FROM player_sessions WHERE job_id = ? ORDER BY user_id')
      .bind(job)
      .all<{ user_id: number; ended_at: number | null; join_source: string }>()
    const byUser = new Map(rows.results.map((r) => [r.user_id, r]))
    expect(byUser.get(b)?.ended_at).not.toBeNull()
    expect(byUser.get(c)?.join_source).toBe('reconciled')
    expect(byUser.get(a)?.ended_at).toBeNull()
  })

  it('records a leave whose join was never received without inventing a live player', async () => {
    const job = jobId()
    const u = uid()
    const before = await live()
    await ingestOk(batch(job, { events: [{ type: 'leave', u, j: Date.now() - 60_000, at: Date.now() }] }))
    const after = await live()
    expect(after.ccu).toBe(before.ccu)
    expect(after.today.sessionsEnded).toBe(before.today.sessionsEnded + 1)
  })
})

describe('purchases', () => {
  it('counts a developer product purchase once even when reported repeatedly', async () => {
    const job = jobId()
    const u = uid()
    const pid = `purchase-${crypto.randomUUID()}`
    const before = await live()
    const first = await ingestOk(batch(job, { events: [purchase(u, pid)] }))
    expect(first.accepted).toBe(1)
    // ProcessReceipt can run again for the same receipt; the module may also retry.
    const second = await ingestOk(batch(job, { events: [purchase(u, pid)] }))
    expect(second.duplicates).toBe(1)
    const after = await live()
    expect(after.today.revenue).toBe(before.today.revenue + 249)
    expect(after.today.sales).toBe(before.today.sales + 1)
    expect(after.allTime.revenue).toBe(before.allTime.revenue + 249)
    const n = await (await db()).prepare('SELECT COUNT(*) AS c FROM purchases WHERE purchase_id = ?').bind(pid).first<{ c: number }>()
    expect(n?.c).toBe(1)
  })

  it('treats a resent batch (same batchId) as an idempotent duplicate', async () => {
    const b = batch(jobId(), { events: [purchase(uid(), `p-${crypto.randomUUID()}`, 100)] })
    const before = await live()
    await ingestOk(b)
    const again = await ingestOk({ ...b, sentAt: Date.now() })
    expect(again.duplicate).toBe(true)
    expect((await live()).today.revenue).toBe(before.today.revenue + 100)
  })

  it('handles many simultaneous sales from many servers exactly', async () => {
    const before = await live()
    const ids = Array.from({ length: 25 }, () => `p-${crypto.randomUUID()}`)
    const jobs = Array.from({ length: 5 }, () => jobId())
    // Each purchase is sent twice concurrently from different servers.
    await Promise.all(
      [...ids, ...ids].map((id, i) => ingestOk(batch(jobs[i % jobs.length], { events: [purchase(uid(), id, 10 + (ids.indexOf(id) % 3))] }))),
    )
    const expected = ids.reduce((acc, _, i) => acc + 10 + (i % 3), 0)
    const after = await live()
    expect(after.today.revenue - before.today.revenue).toBe(expected)
    expect(after.today.sales - before.today.sales).toBe(ids.length)
  })

  it('dedupes game passes per user and pass, and labels the amount as list price', async () => {
    const u = uid()
    const ev = { type: 'purchase' as const, kind: 'game_pass' as const, productId: 9001, robux: 399, u, at: Date.now(), productName: 'VIP Garage' }
    const before = await live()
    await ingestOk(batch(jobId(), { events: [ev] }))
    await ingestOk(batch(jobId(), { events: [{ ...ev, at: Date.now() }] }))
    const after = await live()
    expect(after.today.gamePassRevenue - before.today.gamePassRevenue).toBe(399)
    const row = await (await db()).prepare('SELECT amount_source FROM purchases WHERE dedupe_key = ?').bind(`gp:${u}:9001`).first()
    expect(row?.amount_source).toBe('list_price')
  })

  it('rejects developer product purchases without a receipt PurchaseId', async () => {
    const res = await ingest(batch(jobId(), { events: [{ ...purchase(uid(), 'x'), purchaseId: undefined }] }))
    expect(res.status).toBe(400)
  })

  it('rejects malformed values', async () => {
    expect((await ingest(batch(jobId(), { events: [{ ...purchase(uid(), 'p1'), robux: -5 }] }))).status).toBe(400)
    expect((await ingest('{not json')).status).toBe(400)
    expect((await ingest({ ...batch(jobId()), events: Array.from({ length: 201 }, () => ({ type: 'join', u: 1, j: Date.now() })) })).status).toBe(400)
    expect((await ingest({ ...batch(jobId()), server: { jobId: "'; DROP TABLE purchases;--" } })).status).toBe(400)
  })
})

describe('data separation and safety', () => {
  it('stores Roblox Studio test traffic separately and never counts it', async () => {
    const before = await live()
    const job = jobId()
    await ingestOk(batch(job, { studio: true, events: [{ type: 'join', u: uid(), j: Date.now() }, purchase(uid(), `studio-${crypto.randomUUID()}`, 999)] }))
    const after = await live()
    expect(after.ccu).toBe(before.ccu)
    expect(after.today.revenue).toBe(before.today.revenue)
    const row = await (await db()).prepare('SELECT source FROM server_sessions WHERE job_id = ?').bind(job).first()
    expect(row?.source).toBe('studio')
    const integ = await api<{ servers: { jobId: string; source: string }[] }>('/api/admin/integration')
    expect(integ.body.servers.find((s) => s.jobId === job)?.source).toBe('studio')
  })

  it('refuses synthetic events in production mode', async () => {
    const res = await ingest(batch(jobId(), { synthetic: true, events: [purchase(uid(), `s-${crypto.randomUUID()}`)] }))
    expect(res.status).toBe(403)
    const gen = await api('/api/admin/synthetic', { method: 'POST', body: JSON.stringify({ action: 'purchase' }) })
    expect(gen.status).toBe(403)
  })

  it('rejects events from a different universe once a universe is configured', async () => {
    await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ universeId: null }) })
    const set = await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ officialPollSec: 30 }) })
    expect(set.status).toBe(200)
    // Configure without triggering an outbound Roblox poll by using the hub directly.
    const { runInDurableObject } = await import('cloudflare:test')
    const { hubStub } = await import('../helpers')
    await runInDurableObject(await hubStub(), (inst: unknown) => {
      ;(inst as { config: { universeId: string | null } }).config.universeId = '12345'
    })
    const res = await ingest(batch(jobId(), { universeId: 999, events: [{ type: 'join', u: uid(), j: Date.now() }] }))
    expect(res.status).toBe(403)
    const ok = await ingest(batch(jobId(), { universeId: 12345, events: [{ type: 'join', u: uid(), j: Date.now() }] }))
    expect(ok.status).toBe(200)
    await runInDurableObject(await hubStub(), (inst: unknown) => {
      ;(inst as { config: { universeId: string | null } }).config.universeId = null
    })
  })

  it('rate-limits a single server that floods the endpoint', async () => {
    const job = jobId()
    let limited: Response | null = null
    for (let i = 0; i < 80 && !limited; i++) {
      const res = await ingest(batch(job))
      if (res.status === 429) limited = res
    }
    expect(limited).not.toBeNull()
    expect(limited!.headers.get('retry-after')).toBeTruthy()
  })

  it('tells servers how often to send heartbeats', async () => {
    const res = await ingestOk(batch(jobId()))
    expect(res.heartbeatSec).toBeGreaterThanOrEqual(60)
    expect(res.flushSec).toBeGreaterThanOrEqual(1)
  })
})
