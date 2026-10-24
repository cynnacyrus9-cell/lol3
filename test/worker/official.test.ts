import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInDurableObject } from 'cloudflare:test'
import { api, hubStub, live } from '../helpers'

type Resp = () => Response
let next: Resp = () => Response.json({ data: [] })
let votes: Resp = () => Response.json({ data: [{ id: 4242, upVotes: 530, downVotes: 470 }] })
const realFetch = globalThis.fetch

function mockRoblox() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://games.roblox.com/v1/games/votes')) return votes()
    if (url.startsWith('https://games.roblox.com/')) return next()
    return realFetch(input as RequestInfo, init)
  })
}

async function poll() {
  return api<{ ok: boolean; official?: { visits: number | null; status: string; lastError: string | null } }>('/api/admin/poll-official', { method: 'POST', body: '{}' })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await runInDurableObject(await hubStub(), (inst: unknown) => {
    ;(inst as { config: { universeId: string | null } }).config.universeId = null
  })
})

describe('official Roblox metrics', () => {
  it('fetches the official visit count and keeps the last verified value on errors', async () => {
    mockRoblox()
    next = () => Response.json({ data: [{ id: 4242, name: 'Roadster Life', rootPlaceId: 1, visits: 1_000_000, playing: 37, favoritedCount: 900 }] })
    await runInDurableObject(await hubStub(), (inst: unknown) => {
      ;(inst as { config: { universeId: string | null } }).config.universeId = '4242'
    })
    const ok = await poll()
    expect(ok.status).toBe(200)
    expect(ok.body.official?.visits).toBe(1_000_000)
    expect((await live()).official.playing).toBe(37)

    // Rate limited: back off and keep the last verified count.
    next = () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } })
    const limited = await poll()
    expect(limited.status).toBe(502)
    const l = await live()
    expect(l.official.visits).toBe(1_000_000)
    expect(l.official.lastError).toMatch(/rate limited/i)
    expect(l.official.nextPollAt! - Date.now()).toBeGreaterThanOrEqual(110_000)

    // Missing or malformed fields are errors, never zeros.
    next = () => Response.json({ data: [{ id: 4242, visits: 'lots' }] })
    expect((await poll()).status).toBe(502)
    next = () => Response.json({ data: [] })
    expect((await poll()).status).toBe(502)
    next = () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    expect((await poll()).status).toBe(502)
    next = () => new Response('down', { status: 503 })
    expect((await poll()).status).toBe(502)
    expect((await live()).official.visits).toBe(1_000_000)

    // Recovery: a new verified value replaces the old one.
    next = () => Response.json({ data: [{ id: 4242, visits: 1_000_250, playing: 40, favoritedCount: 901 }] })
    const recovered = await poll()
    expect(recovered.body.official?.visits).toBe(1_000_250)
    expect(recovered.body.official?.lastError).toBeNull()
  })

  it('derives like ratio and rolling visit windows only from real snapshots', async () => {
    mockRoblox()
    const { db } = await import('../helpers')
    const d1 = await db()
    const now = Date.now()
    // History: 61 min ago 9,000 visits; 16 min ago 9,700. Nothing from 24 h ago.
    await d1.batch([
      d1.prepare('INSERT OR REPLACE INTO official_snapshots (fetched_at, visits, playing, favorites) VALUES (?, ?, 1, 1)').bind(now - 61 * 60_000, 9_000),
      d1.prepare('INSERT OR REPLACE INTO official_snapshots (fetched_at, visits, playing, favorites) VALUES (?, ?, 1, 1)').bind(now - 16 * 60_000, 9_700),
    ])
    next = () => Response.json({ data: [{ id: 4242, visits: 10_000, playing: 12, favoritedCount: 50 }] })
    await runInDurableObject(await hubStub(), (inst: unknown) => {
      ;(inst as { config: { universeId: string | null } }).config.universeId = '4242'
    })
    const r = await poll()
    expect(r.status).toBe(200)
    const o = (await live()).official
    expect(o.upVotes).toBe(530)
    expect(o.downVotes).toBe(470)
    expect(o.visitsLastHour).toBe(1_000)
    expect(o.visitsPerMinute).toBe(20)
    // No data from 24 h ago (and the closest older snapshot would be a polling gap): unknown, not guessed.
    expect(o.visitsLastDay).toBeNull()

    // A votes failure never blocks the visit count.
    votes = () => new Response('nope', { status: 500 })
    next = () => Response.json({ data: [{ id: 4242, visits: 10_050, playing: 12, favoritedCount: 50 }] })
    expect((await poll()).status).toBe(200)
    expect((await live()).official.visits).toBe(10_050)
  })

  it('reports the official source as unavailable when no universe is configured', async () => {
    const l = await live()
    expect(l.official.status).toBe('unavailable')
    expect(l.official.visits).toBeNull()
  })
})
