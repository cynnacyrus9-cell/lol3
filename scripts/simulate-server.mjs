#!/usr/bin/env node
// Development helper: behaves like N Roblox game servers and sends SIGNED,
// explicitly SYNTHETIC events to a development backend (APP_MODE=development).
// Production backends reject synthetic batches with HTTP 403.
//
//   node scripts/simulate-server.mjs --url http://127.0.0.1:8787 --secret <INGEST_SECRET> [--servers 3] [--minutes 5]
import { createHmac, randomUUID } from 'node:crypto'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
)
const url = `${(args.url ?? 'http://127.0.0.1:8787').replace(/\/$/, '')}/ingest`
const secret = args.secret ?? process.env.INGEST_SECRET
const serverCount = Number(args.servers ?? 3)
const minutes = Number(args.minutes ?? 5)
if (!secret) {
  console.error('Pass --secret (the INGEST_SECRET of your development backend)')
  process.exit(1)
}

const products = [
  { id: 1001, name: 'Nitro Boost', price: 49 },
  { id: 1002, name: 'Cash Pack (Small)', price: 99 },
  { id: 1003, name: 'Cash Pack (Large)', price: 249 },
  { id: 1004, name: 'Custom Paint', price: 25 },
]
const passes = [
  { id: 2001, name: 'VIP Garage', price: 399 },
  { id: 2002, name: 'Drift Kit', price: 149 },
]

async function send(server, events, players) {
  const body = JSON.stringify({ v: 1, batchId: randomUUID(), sentAt: Date.now(), synthetic: true, server, players, events })
  const ts = String(Date.now())
  const sig = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rl-timestamp': ts, 'x-rl-signature': `v1=${sig}` }, body })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) console.error(`  ${server.jobId.slice(0, 8)} → ${res.status} ${out.error ?? ''}`)
  return out
}

const servers = Array.from({ length: serverCount }, () => ({
  info: { jobId: randomUUID(), placeId: 1234567, universeId: undefined, startedAt: Date.now() },
  players: new Map(),
}))

let nextUser = 1_000_000_000 + Math.floor(Math.random() * 1e6)
const end = Date.now() + minutes * 60_000
console.log(`Simulating ${serverCount} synthetic servers for ${minutes} min against ${url}`)
let tick = 0
while (Date.now() < end) {
  for (const s of servers) {
    const events = []
    if (s.players.size < 18 && Math.random() < 0.6) {
      const u = nextUser++
      const j = Date.now()
      s.players.set(u, j)
      events.push({ type: 'join', u, j, n: `Racer${u % 10000}` })
    }
    if (s.players.size > 3 && Math.random() < 0.25) {
      const [u, j] = [...s.players.entries()][Math.floor(Math.random() * s.players.size)]
      s.players.delete(u)
      events.push({ type: 'leave', u, j, at: Date.now() })
    }
    if (s.players.size && Math.random() < 0.12) {
      const u = [...s.players.keys()][Math.floor(Math.random() * s.players.size)]
      if (Math.random() < 0.8) {
        const p = products[Math.floor(Math.random() * products.length)]
        events.push({ type: 'purchase', kind: 'developer_product', productId: p.id, productName: p.name, robux: p.price, u, at: Date.now(), purchaseId: `sim-${randomUUID()}`, currencyType: 'Robux' })
      } else {
        const p = passes[Math.floor(Math.random() * passes.length)]
        events.push({ type: 'purchase', kind: 'game_pass', productId: p.id, productName: p.name, robux: p.price, u, at: Date.now() })
      }
    }
    const players = [...s.players.entries()].map(([u, j]) => ({ u, j }))
    if (events.length || tick % 6 === 0) await send(s.info, events, players)
  }
  tick++
  await new Promise((r) => setTimeout(r, 2500))
}
for (const s of servers) await send(s.info, [{ type: 'server_close', at: Date.now() }], [])
console.log('Done.')
