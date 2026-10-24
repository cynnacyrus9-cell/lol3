import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '../../shared/types'
import { batch, ingestOk, jobId, login, ORIGIN, uid, worker } from '../helpers'

async function connect(since?: number) {
  const cookie = await login()
  const res = await worker.fetch(`${ORIGIN}/api/live${since ? `?since=${since}` : ''}`, {
    headers: { upgrade: 'websocket', origin: ORIGIN, cookie },
  })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  const messages: ServerMessage[] = []
  const waiters: (() => void)[] = []
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string' && e.data !== 'pong') messages.push(JSON.parse(e.data))
    waiters.splice(0).forEach((w) => w())
  })
  ws.accept()
  const waitFor = async (pred: (m: ServerMessage) => boolean, timeoutMs = 2000): Promise<ServerMessage> => {
    const start = Date.now()
    for (;;) {
      const hit = messages.find(pred)
      if (hit) return hit
      if (Date.now() - start > timeoutMs) throw new Error(`timed out; got ${messages.map((m) => m.t).join(',')}`)
      await new Promise<void>((r) => {
        waiters.push(r)
        setTimeout(r, 50)
      })
    }
  }
  return { ws, messages, waitFor }
}

describe('WebSocket live updates', () => {
  it('rejects upgrades from another origin', async () => {
    const cookie = await login()
    const res = await worker.fetch(`${ORIGIN}/api/live`, { headers: { upgrade: 'websocket', origin: 'https://evil.example', cookie } })
    expect(res.status).toBe(403)
  })

  it('sends a hello snapshot, then pushes joins and sales as they are ingested', async () => {
    const { ws, waitFor } = await connect()
    const hello = (await waitFor((m) => m.t === 'hello')) as Extract<ServerMessage, { t: 'hello' }>
    const ccu0 = hello.live.ccu
    const u = uid()
    const started = Date.now()
    await ingestOk(batch(jobId(), { events: [{ type: 'join', u, j: Date.now() }] }))
    const update = (await waitFor((m) => m.t === 'live' && m.live.ccu === ccu0 + 1)) as Extract<ServerMessage, { t: 'live' }>
    expect(update.live.ccu).toBe(ccu0 + 1)
    await waitFor((m) => m.t === 'event' && m.event.type === 'player_join' && m.event.data.userId === u)
    const pid = `p-${crypto.randomUUID()}`
    await ingestOk(batch(jobId(), { events: [{ type: 'purchase', kind: 'developer_product', productId: 1, robux: 249, u, at: Date.now(), purchaseId: pid }] }))
    const sale = (await waitFor((m) => m.t === 'sale' && m.sale.dedupeKey === `dp:${pid}`)) as Extract<ServerMessage, { t: 'sale' }>
    expect(sale.sale.robux).toBe(249)
    expect(Date.now() - started).toBeLessThan(2000)
    ws.close(1000, 'done')
  })

  it('auto-answers keep-alive pings', async () => {
    const { ws } = await connect()
    const pong = new Promise<string>((resolve) => ws.addEventListener('message', (e) => e.data === 'pong' && resolve(e.data as string)))
    ws.send('ping')
    expect(await pong).toBe('pong')
    ws.close(1000)
  })

  it('replays events missed while a dashboard was disconnected', async () => {
    const first = await connect()
    const hello = (await first.waitFor((m) => m.t === 'hello')) as Extract<ServerMessage, { t: 'hello' }>
    const lastSeq = hello.live.seq
    first.ws.close(1000, 'network drop')
    const u = uid()
    await ingestOk(batch(jobId(), { events: [{ type: 'join', u, j: Date.now() }] }))
    const second = await connect(lastSeq)
    const resumed = (await second.waitFor((m) => m.t === 'hello')) as Extract<ServerMessage, { t: 'hello' }>
    expect(resumed.gap).toBe(false)
    expect(resumed.missed.some((e) => e.type === 'player_join' && e.data.userId === u)).toBe(true)
    expect(resumed.missed.every((e) => e.seq > lastSeq)).toBe(true)
    second.ws.close(1000)
  })
})
