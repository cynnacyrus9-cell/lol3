#!/usr/bin/env node
// Interactive helper that stores secrets with `wrangler secret put` (encrypted at
// Cloudflare, never written to this repository). Leave a prompt empty to skip;
// INGEST_SECRET and SESSION_SECRET are generated if left empty.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = async (q) => (await rl.question(q)).trim()

function put(name, value) {
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], { input: value, stdio: ['pipe', 'inherit', 'inherit'] })
  if (r.status !== 0) {
    console.error(`Failed to set ${name}`)
    process.exit(1)
  }
}

console.log('Roadster Life Analytics — secret setup (values are sent only to Cloudflare)\n')
let ingest = await ask('INGEST_SECRET (Enter = generate a strong random value): ')
if (!ingest) ingest = randomBytes(32).toString('base64url')
if (ingest.length < 24) throw new Error('INGEST_SECRET must be at least 24 characters')
put('INGEST_SECRET', ingest)
console.log('\nCopy this INGEST_SECRET into Roblox (Creator Hub → your experience → Secrets). It is shown only once:\n')
console.log(`   ${ingest}\n`)

const mode = (await ask('Dashboard sign-in: [a]ccess (Cloudflare Access, recommended) or [p]assword? ')).toLowerCase()
if (mode.startsWith('p')) {
  const pw = await ask('DASHBOARD_PASSWORD (min 12 chars): ')
  if (pw.length < 12) throw new Error('Password too short')
  put('DASHBOARD_PASSWORD', pw)
  put('SESSION_SECRET', randomBytes(48).toString('base64url'))
  console.log('Remember to set "AUTH_MODE": "password" in wrangler.jsonc vars.')
}

const key = await ask('ROBLOX_OPEN_CLOUD_API_KEY (optional, Enter to skip): ')
if (key) put('ROBLOX_OPEN_CLOUD_API_KEY', key)
const cf = await ask('CF_API_TOKEN with "Account Analytics: Read" (optional, Enter to skip): ')
if (cf) put('CF_API_TOKEN', cf)

rl.close()
console.log('\nDone. Run `npm run deploy` to publish.')
