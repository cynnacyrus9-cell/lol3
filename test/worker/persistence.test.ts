import { describe, expect, it } from 'vitest'
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { addDays, dayKey, dayStartUtc, DEFAULT_TIMEZONE } from '../../shared/time'
import { api, batch, db, hubStub, ingestOk, jobId, live, uid } from '../helpers'

const TZ = DEFAULT_TIMEZONE
const buy = (robux: number, at = Date.now()) => ({
  type: 'purchase' as const,
  kind: 'developer_product' as const,
  productId: 777,
  robux,
  u: uid(),
  at,
  purchaseId: `p-${crypto.randomUUID()}`,
})

type Meta = { today: { dayKey: string; revenue: number; sales: number }; dirtyDays: string[] }

describe('persistence', () => {
  it('keeps live state and totals after the Durable Object is evicted', async () => {
    // Talk to the hub directly: requests routed through the in-isolate test
    // entrypoint keep the object pinned, which blocks evictDurableObject().
    const stub = await hubStub()
    const hubIngest = async (b: unknown) => {
      const r = await stub.fetch('https://hub/ingest', { method: 'POST', headers: { 'x-rl-kind': 'ingest' }, body: JSON.stringify(b) })
      expect(r.status).toBe(200)
      await r.text()
    }
    const snapshot = async () => {
      const r = await stub.fetch('https://hub/api/bootstrap', { headers: { 'x-rl-kind': 'api' } })
      return ((await r.json()) as { live: import('../../shared/types').LiveSnapshot }).live
    }
    const job = jobId()
    await hubIngest(batch(job, { events: [{ type: 'join', u: uid(), j: Date.now() }, buy(321)] }))
    const before = await snapshot()
    await evictDurableObject(stub)
    const after = await snapshot()
    expect(after.ccu).toBe(before.ccu)
    expect(after.today.revenue).toBe(before.today.revenue)
    expect(after.allTime.revenue).toBe(before.allTime.revenue)
    expect(after.seq).toBeGreaterThanOrEqual(before.seq)
    // Sequence numbers keep increasing after a restart (no reuse).
    await hubIngest(batch(job, { events: [buy(1)] }))
    expect((await snapshot()).seq).toBeGreaterThan(before.seq)
  })

  it('stores purchases permanently in D1', async () => {
    const ev = buy(55)
    await ingestOk(batch(jobId(), { events: [ev] }))
    const row = await (await db()).prepare('SELECT robux, source, kind FROM purchases WHERE purchase_id = ?').bind(ev.purchaseId).first()
    expect(row).toMatchObject({ robux: 55, source: 'live', kind: 'developer_product' })
  })
})

describe('daily counters and timezone boundaries', () => {
  it('resets "today" at local midnight and finalises the previous day from raw rows', async () => {
    const stub = await hubStub()
    const today = dayKey(Date.now(), TZ)
    const yesterday = addDays(today, -1)
    // Pretend the hub last ran yesterday with inflated (wrong) counters.
    await runInDurableObject(stub, (inst: unknown) => {
      const m = (inst as { meta: Meta }).meta
      m.today.dayKey = yesterday
      m.today.revenue = 999_999
      m.today.sales = 42
    })
    const after = await live()
    expect(after.today.dayKey).toBe(today)
    expect(after.today.revenue).toBe(0)
    const dirty = await runInDurableObject(stub, (inst: unknown) => (inst as { meta: Meta }).meta.dirtyDays)
    expect(dirty).toContain(yesterday)
    await runDurableObjectAlarm(stub)
    const agg = await (await db()).prepare('SELECT revenue_robux, finalized FROM daily_aggregates WHERE tz = ? AND day = ?').bind(TZ, yesterday).first()
    // Recomputed from purchases, not copied from the in-memory counter.
    expect(agg?.revenue_robux).not.toBe(999_999)
    expect(agg?.finalized).toBe(1)
  })

  it('assigns purchases on either side of Los Angeles midnight to the correct day', async () => {
    const now = Date.now()
    const today = dayKey(now, TZ)
    const midnight = dayStartUtc(today, TZ)
    if (now - midnight < 2_000) return // too close to midnight to construct the case
    const late = buy(70, midnight - 500) // 23:59:59.5 yesterday (LA)
    const early = buy(30, midnight + 500) // 00:00:00.5 today (LA)
    const before = await live()
    const yBefore = await api<{ current: { revenue: number } }>('/api/summary?range=yesterday')
    await ingestOk(batch(jobId(), { events: [late, early] }))
    const after = await live()
    expect(after.today.revenue - before.today.revenue).toBe(30)
    await runDurableObjectAlarm(await hubStub())
    const yAfter = await api<{ current: { revenue: number } }>('/api/summary?range=yesterday')
    expect(yAfter.body.current.revenue - yBefore.body.current.revenue).toBe(70)
  })

  it('recomputing a day twice gives identical totals (idempotent aggregation)', async () => {
    const today = dayKey(Date.now(), TZ)
    await ingestOk(batch(jobId(), { events: [buy(10), buy(20)] }))
    const a = await api<{ today: { revenue: number } }>('/api/admin/recompute', { method: 'POST', body: '{}' })
    const b = await api<{ today: { revenue: number } }>('/api/admin/recompute', { method: 'POST', body: '{}' })
    expect(a.status).toBe(200)
    expect(b.body.today.revenue).toBe(a.body.today.revenue)
    const row = await (await db()).prepare('SELECT SUM(robux) AS r FROM purchases WHERE source = ? AND purchased_at >= ?').bind('live', dayStartUtc(today, TZ)).first<{ r: number }>()
    expect(a.body.today.revenue).toBe(row?.r)
  })
})

describe('reports', () => {
  it('returns range summaries with previous-period comparisons', async () => {
    for (const range of ['today', 'yesterday', '7d', '30d', 'week', 'month', 'all']) {
      const r = await api<{ current: { revenue: number }; range: { preset: string } }>(`/api/summary?range=${range}`)
      expect(r.status, range).toBe(200)
      expect(r.body.range.preset).toBe(range)
    }
    const today = dayKey(Date.now(), TZ)
    const custom = await api(`/api/summary?range=custom&from=${addDays(today, -3)}&to=${today}`)
    expect(custom.status).toBe(200)
    const bad = await api(`/api/summary?range=custom&from=nope&to=${today}`)
    expect(bad.status).toBe(400)
  })

  it('exports CSV with spreadsheet-formula injection neutralised', async () => {
    await ingestOk(batch(jobId(), { events: [{ ...buy(5), productName: '=HYPERLINK("http://x")' }] }))
    const r = await api<string>('/api/export.csv?kind=purchases&range=today')
    expect(r.status).toBe(200)
    expect(r.body.split('\r\n')[0]).toContain('purchased_at_utc')
    expect(r.body).toContain(`"'=HYPERLINK(""http://x"")"`)
  })

  it('serves chart series without fabricating history', async () => {
    for (const w of ['5m', '15m', '1h', '6h', '24h', '7d']) {
      const r = await api<{ points: unknown[] }>(`/api/series/ccu?window=${w}`)
      expect(r.status).toBe(200)
      expect(Array.isArray(r.body.points)).toBe(true)
    }
    const rev = await api<{ granularity: string; buckets: { revenue: number }[] }>('/api/series/revenue?range=today')
    expect(rev.body.granularity).toBe('hour')
    const visits = await api<{ buckets: { tracked: number; official: number | null }[] }>('/api/series/visits?range=today')
    // No official snapshots were collected in this test run: official stays null, never 0-filled.
    expect(visits.body.buckets.every((b) => b.official === null)).toBe(true)
  })
})
