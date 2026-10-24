import { describe, expect, it } from 'vitest'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { api, batch, db, hubStub, ingestOk, jobId, live, uid } from '../helpers'

type HubInternals = { servers: Map<string, { lastSeenAt: number; heartbeatSec: number }> }

async function ageServer(job: string, ms: number) {
  await runInDurableObject(await hubStub(), (inst: unknown) => {
    const s = (inst as HubInternals).servers.get(job)
    if (!s) throw new Error('server not found in hub')
    s.lastSeenAt -= ms
  })
}

describe('server lifecycle', () => {
  it('opens a server on its first message and closes it cleanly on shutdown', async () => {
    const job = jobId()
    const u = uid()
    const j = Date.now() - 30_000
    const before = await live()
    await ingestOk(batch(job, { events: [{ type: 'join', u, j }] }))
    expect((await live()).activeServers).toBe(before.activeServers + 1)
    await ingestOk(batch(job, { events: [{ type: 'server_close', at: Date.now() }] }))
    const after = await live()
    expect(after.activeServers).toBe(before.activeServers)
    expect(after.ccu).toBe(before.ccu)
    const s = await (await db()).prepare('SELECT end_reason FROM server_sessions WHERE job_id = ?').bind(job).first()
    expect(s?.end_reason).toBe('shutdown')
    const p = await (await db()).prepare('SELECT end_reason FROM player_sessions WHERE job_id = ?').bind(job).first()
    expect(p?.end_reason).toBe('server_shutdown')
    const feed = await api<{ events: { type: string; data: { jobId?: string } }[] }>('/api/activity?categories=servers&limit=20')
    const types = feed.body.events.filter((e) => e.data.jobId === job).map((e) => e.type)
    expect(types).toEqual(expect.arrayContaining(['server_open', 'server_close']))
  })

  it('detects a crashed server from missing heartbeats and ends its sessions at the last heartbeat', async () => {
    const job = jobId()
    const players = [uid(), uid(), uid()]
    const j = Date.now() - 30 * 60_000
    const before = await live()
    await ingestOk(batch(job, { events: players.map((u) => ({ type: 'join' as const, u, j })) }))
    expect((await live()).ccu).toBe(before.ccu + 3)

    // Still within the timeout: an alarm must not close it.
    await ageServer(job, 60_000)
    await runDurableObjectAlarm(await hubStub())
    expect((await live()).ccu).toBe(before.ccu + 3)

    // Well beyond 3 × heartbeat interval: the server is presumed dead.
    await ageServer(job, 10 * 60_000)
    await runDurableObjectAlarm(await hubStub())
    const after = await live()
    expect(after.ccu).toBe(before.ccu)
    expect(after.activeServers).toBe(before.activeServers)
    const rows = await (await db()).prepare('SELECT end_reason, ended_at FROM player_sessions WHERE job_id = ?').bind(job).all<{ end_reason: string; ended_at: number }>()
    expect(rows.results).toHaveLength(3)
    for (const r of rows.results) {
      expect(r.end_reason).toBe('server_timeout')
      expect(r.ended_at).toBeLessThan(Date.now() - 9 * 60_000)
    }
    const s = await (await db()).prepare('SELECT end_reason FROM server_sessions WHERE job_id = ?').bind(job).first()
    expect(s?.end_reason).toBe('heartbeat_timeout')
  })

  it('reopens sessions if a server presumed dead starts reporting again', async () => {
    const job = jobId()
    const u = uid()
    const j = Date.now() - 60_000
    await ingestOk(batch(job, { events: [{ type: 'join', u, j }] }))
    await ageServer(job, 20 * 60_000)
    await runDurableObjectAlarm(await hubStub())
    const before = await live()
    // Network blip over: the server sends its normal heartbeat with the same roster.
    await ingestOk(batch(job, { players: [{ u, j }] }))
    const after = await live()
    expect(after.ccu).toBe(before.ccu + 1)
    const row = await (await db()).prepare('SELECT ended_at, end_reason FROM player_sessions WHERE session_id = ?').bind(`${job}:${u}:${j}`).first()
    expect(row).toMatchObject({ ended_at: null, end_reason: null })
  })
})
