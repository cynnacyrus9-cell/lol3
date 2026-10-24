import { describe, expect, it } from 'vitest'
import { api, db, live } from '../helpers'

describe('development test mode', () => {
  it('generates explicitly labelled synthetic events that flow through the real pipeline', async () => {
    const before = await live()
    expect(before.mode).toBe('development')
    const join = await api<{ ok: boolean }>('/api/admin/synthetic', { method: 'POST', body: JSON.stringify({ action: 'join' }) })
    expect(join.body.ok).toBe(true)
    const buy = await api<{ ok: boolean }>('/api/admin/synthetic', { method: 'POST', body: JSON.stringify({ action: 'purchase' }) })
    expect(buy.body.ok).toBe(true)
    const after = await live()
    expect(after.ccu).toBe(before.ccu + 1)
    expect(after.today.sales).toBe(before.today.sales + 1)
    const rows = await (await db()).prepare(`SELECT DISTINCT source FROM purchases`).all<{ source: string }>()
    expect(rows.results.map((r) => r.source)).toEqual(['synthetic'])
    const feed = await api<{ events: { source: string; type: string }[] }>('/api/activity?limit=10')
    expect(feed.body.events.length).toBeGreaterThan(0)
    expect(feed.body.events.every((e) => e.source === 'synthetic')).toBe(true)
  })
})
