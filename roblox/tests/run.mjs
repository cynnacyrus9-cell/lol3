// Runs the Luau test-suite for the Roblox integration under real Luau (WASM).
// Each test gets a fresh VM with mocked Roblox services and a virtual clock.
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { LuauState } from 'luau-web'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (p) => readFileSync(path.join(here, '..', p), 'utf8')
const MODULE_DIR = 'src/ServerScriptService/RoadsterAnalytics'
const sources = {
  mocks: src('tests/mocks.luau'),
  Sha256: src(`${MODULE_DIR}/Sha256.luau`),
  Config: src(`${MODULE_DIR}/Config.luau`),
  RoadsterAnalytics: src(`${MODULE_DIR}/init.luau`),
  tests: src('tests/tests.luau'),
  bootstrap: src('src/ServerScriptService/RoadsterAnalyticsBootstrap.server.luau'),
}

// Engine values that a real server fixes before scripts run (Luau caches
// imports such as game.JobId when a chunk loads), applied before the module loads.
const setups = {
  'ignores Studio test clients with negative user ids and flags Studio servers': 'game.JobId = ""',
}

async function freshState(name) {
  const out = []
  const state = await LuauState.createAsync({ print: (...a) => out.push(a.join(' ')) })
  const run = async (code, name) => {
    const fn = state.loadstring(code, name, true)
    return (await fn())?.[0]
  }
  await run(`__now = ${Date.now()}`, 'clock')
  await run(sources.mocks, 'mocks')
  if (setups[name]) await run(`${setups[name]}\nreturn true`, 'setup')
  for (const m of ['Sha256', 'Config', 'RoadsterAnalytics']) {
    await run(`__MODULES[${JSON.stringify(m)}] = (function()\n${sources[m]}\nend)()\nreturn true`, m)
  }
  await run(sources.tests, 'tests')
  return { state, run, out }
}

const expectations = {
  'sha256 vectors': (r) => {
    const sha = (s) => createHash('sha256').update(s).digest('hex')
    const hmac = (k, m) => createHmac('sha256', k).update(m).digest('hex')
    const want = {
      empty: sha(''),
      abc: sha('abc'),
      long: sha('a'.repeat(1000)),
      block: sha('x'.repeat(55)),
      block2: sha('y'.repeat(64)),
      hmacShort: hmac('key', 'The quick brown fox jumps over the lazy dog'),
      hmacLongKey: hmac('k'.repeat(100), 'message'),
    }
    for (const [k, v] of Object.entries(want)) if (r[k] !== v) throw new Error(`${k}: expected ${v}, got ${r[k]}`)
  },
  'signs requests with HMAC when a signing secret is configured': (r) => {
    const expected = createHmac('sha256', 'hmac-secret-abcdefghijklmnopqrstuvwxyz').update(`${r.ts}.${r.body}`).digest('hex')
    if (r.sig !== `v1=${expected}`) throw new Error(`signature mismatch: ${r.sig} vs v1=${expected}`)
    if (Math.abs(Number(r.ts) - Date.now()) > 60_000) throw new Error('timestamp not current')
    JSON.parse(r.body) // the signed body is valid JSON
  },
}

const { run: listRun } = await freshState()
const names = String(await listRun(`local n = {} for k in pairs(TESTS) do table.insert(n, k) end table.sort(n) return table.concat(n, "\\n")`, 'list')).split('\n')

let failed = 0
for (const name of names) {
  const { run } = await freshState(name)
  const result = String(
    await run(
      `local ok, r = pcall(TESTS[${JSON.stringify(name)}])
       if not ok then return "FAIL " .. tostring(r) end
       return "OK " .. __JSON.encode(r or {})`,
      'test',
    ),
  )
  let error = null
  if (result.startsWith('FAIL ')) error = result.slice(5)
  else {
    try {
      expectations[name]?.(JSON.parse(result.slice(3)))
    } catch (e) {
      error = e.message
    }
  }
  if (error) {
    failed++
    console.log(`  ✗ ${name}\n      ${error}`)
  } else console.log(`  ✓ ${name}`)
}

// The bootstrap Script must load and start the module.
{
  const { run } = await freshState()
  const r = String(
    await run(
      `local Config = __MODULES.Config
       Config.Endpoint = "https://analytics.example.workers.dev/ingest"
       local ok, err = pcall(function() ${sources.bootstrap.replace(/\]\]/g, '')} end)
       if not ok then return "FAIL " .. tostring(err) end
       return __MODULES.RoadsterAnalytics.GetStats().started and "OK" or "FAIL not started"`,
      'bootstrap',
    ),
  )
  if (r !== 'OK') {
    failed++
    console.log(`  ✗ bootstrap script starts the module\n      ${r}`)
  } else console.log('  ✓ bootstrap script starts the module')
}

console.log(`\nLuau: ${names.length + 1 - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
