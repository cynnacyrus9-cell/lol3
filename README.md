# Roadster Life Analytics

A private, real-time analytics dashboard for the Roblox experience **Roadster Life**.
It runs entirely on Cloudflare's free plan: Workers, Static Assets, one SQLite-backed
Durable Object, and D1.

- **Event-driven.** Roblox game servers push joins, leaves, heartbeats and verified
  purchases to the backend. The backend persists them and broadcasts them over
  WebSockets to every open dashboard. A sale shows up as a `NEW SALE — 249 ROBUX`
  notification within about a second of the game granting the item.
- **No fabricated numbers.** Nothing is randomly generated or back-filled.
  Development-only synthetic events are rejected by production backends and are
  labelled `SYNTHETIC` wherever they appear. Days before tracking began show as
  "no data", not zero.
- **Honest sources.** Every metric shows where it comes from (*Live · in-game*,
  *Roblox API · polled*, *Stored history* or *Unavailable*) and when it was last
  updated. The **Data sources** page lists what is live, what is delayed, and what
  Roblox does not expose.

```
Roblox game servers (Luau module)
   │  POST /ingest  (Secrets-store bearer token or HMAC; batched; purchases sent immediately)
   ▼
Cloudflare Worker ── auth, validation, size limits, CSRF/Origin checks
   │
   ▼
Durable Object "AnalyticsHub" (single instance, SQLite-backed, free plan)
   ├─ idempotent writes to D1 (one transaction per batch, fixed statement count)
   ├─ live state (servers, rosters, today's counters) mirrored in DO storage
   ├─ WebSocket fan-out (Hibernation API, runtime-answered pings)
   ├─ alarm loop: crash detection, CCU snapshots, official Roblox polling,
   │  daily aggregation, retention
   └─ shared caches for all dashboard viewers
   ▼
React dashboard (Vite + Tailwind + shadcn-style components + Recharts)
```

---

## 1. Platform facts and limits this design relies on

Verified in October 2026. Cloudflare and Roblox change these, so re-check them before
you depend on the numbers.

| Item | Value used | Notes |
|---|---|---|
| Workers Free requests | 100,000 / day, resets 00:00 UTC | Error 1027 once exceeded. Static asset requests do not invoke the Worker. |
| Workers Free CPU | 10 ms per invocation | Hot paths are I/O-bound; aggregation runs in SQL. |
| Durable Objects on Free | SQLite-backed classes only; 100,000 requests/day; 13,000 GB-s duration/day | Incoming WebSocket messages are billed 20:1. Outgoing messages, protocol pings and auto-responses are free. Hibernating WebSockets incur no duration. |
| D1 Free | 5,000,000 rows read/day; 100,000 rows written/day; 5 GB | From 1 Sep 2026, free-plan queries fail once a daily limit is exceeded. Each index entry counts as a written row. |
| Roblox HttpService | 500 HTTP requests / minute / game server | This module sends about 1 request/second at most, usually far fewer. |
| Roblox official counters | `GET https://games.roblox.com/v1/games?universeIds=<id>` → `visits`, `playing`, `favoritedCount` | Documented Games API, no authentication. Roblox refreshes these counters on its own schedule. |
| Roblox purchases | `MarketplaceService.ProcessReceipt` (one callback per server; receipt has `PurchaseId`, `CurrencySpent`), `PromptGamePassPurchaseFinished`, `UserOwnsGamePassAsync` | The module never assigns `ProcessReceipt`; you wrap your own handler. |

> **About verification:** this build environment could not open developers.cloudflare.com
> or create.roblox.com directly. The numbers above were checked through web search
> results that quote those official pages. Two items could not be confirmed and are
> handled defensively:
> - **Cloudflare GraphQL usage datasets.** The admin panel shows the error message if
>   Cloudflare's GraphQL dataset names differ.
> - **Roblox Open Cloud endpoint paths.** The Open Cloud key is used only for an optional
>   "test key" button.

### What is live, delayed or unavailable

| Metric | Status | How |
|---|---|---|
| CCU, players per server, joins/leaves, session length, join rate | **Live** | `PlayerAdded`/`PlayerRemoving`, flushed within ~1 s; heartbeats repair missed events; servers that stop heartbeating are closed. |
| Tracked visits, unique players | **Live** | Joins observed since installation. These are *not* Roblox's historical visit count. |
| Developer product sales | **Live** | Reported only after your handler returns `PurchaseGranted`. The amount is the receipt's `CurrencySpent`, deduplicated by `PurchaseId`. |
| Game pass sales made in the experience | **Live** | `wasPurchased = true`, then ownership is confirmed with `UserOwnsGamePassAsync`. The amount is the list price from `GetProductInfo`. |
| Developer products bought from the experience's Store tab | Delayed | Roblox runs `ProcessReceipt` when the buyer next joins a server. |
| Official total visits, "playing", favorites | Delayed (polled) | One shared poller. Every 30 s while any dashboard is open (configurable, minimum 20 s), every 5 min otherwise. Backs off on 429/errors. A changed value is broadcast as soon as it is detected. |
| Gross Robux | Live | Sum of verified purchases. |
| Net Robux | Estimate | Gross × 70% (configurable), always labelled as an estimate. |
| Confirmed net, pending Robux | **Unavailable** | No supported Open Cloud API. Cookie-based economy endpoints are deliberately not used. |
| Game passes bought outside the experience (website) | **Unavailable** | Roblox sends game servers no event for these. They are never inferred or estimated. |
| Earnings and visits before installation | **Unavailable** | The official cumulative visit counter is the only historical figure. |

---

## 2. Staying inside the free plan

| Traffic | Requests/day |
|---|---|
| Each game server: heartbeat every 60 s | 1,440 Worker + 1,440 DO |
| Joins/leaves: batched (1 s window), and heartbeats skip when a batch was just sent | ≈ 1 request per player-event burst |
| Purchases | 1 each (sent immediately) |
| Hub alarm loop: 30 s while active, 5 min idle | ≤ 2,880 DO |
| Cron watchdog (`*/10 * * * *`) | 144 Worker |
| Each dashboard visit | ~6–10 API requests + 1 WebSocket upgrade. Pings are answered by the runtime and cost nothing. |
| Static files (HTML/JS/CSS) | 0 (served by Cloudflare without invoking the Worker) |

Built-in safeguards:

- **Adaptive ingestion budget.** Every ingest response tells each game server its
  heartbeat interval and batching window. As servers or usage grow, heartbeats slow
  down so they stay under about 45% of the daily allowance (e.g. 200 servers → about
  6.5-minute heartbeats). Above 70% projected usage, joins and leaves batch for 5 s;
  above 90%, they batch for 15 s. Purchases are always sent immediately.
- **D1 write protection.** When projected D1 writes pass 90%, join/leave lines in the
  activity feed and extra CCU snapshots pause. Sessions and purchases are always
  recorded.
- **Exact D1 accounting.** Every query's `rows_read`/`rows_written` metadata is summed.
  **Admin → Cloudflare free-tier usage** shows used vs. projected for Worker requests,
  DO requests, D1 reads and D1 writes. Set `CF_ACCOUNT_ID` and `CF_API_TOKEN` to also
  see Cloudflare's own analytics numbers.
- **Shared work.** Browsers never call Roblox. One poller and one in-DO cache serve every
  viewer, and live updates are pushed rather than polled.

**Practical ceiling on the free plan:** roughly **25–35 concurrent game servers** with
normal join activity at 60 s heartbeats. Beyond that, heartbeats stretch automatically.
Live events still arrive, but crashed-server detection becomes slower. Above a few
thousand player sessions per day, D1's 100,000 writes/day becomes the limit
(about 9 writes per session including the activity log). At that point, consider
Workers Paid ($5/month), which removes these caps.

**Durable Objects and WebSockets on the free plan.** The hub uses the WebSocket
Hibernation API, so an idle dashboard costs no duration. Keep-alive pings are
auto-answered without waking the object. A dashboard that is open but receiving
nothing costs nothing. Each update broadcast to it is an *outgoing* message, which is
free. The SSE fallback (only used when WebSockets are blocked) keeps the object awake.
Each SSE stream is therefore closed after 2 minutes and reconnects with
`Last-Event-ID`, and at most 50 SSE streams are allowed.

---

## 3. Deploy to Cloudflare

Prerequisites: Node 20+, a Cloudflare account (free), and your Roblox experience's
Place ID.

```bash
npm install
npx wrangler login

# 1) Create the D1 database and paste the printed database_id into wrangler.jsonc
npx wrangler d1 create roadster-analytics

# 2) Create the tables
npm run db:migrate:remote

# 3) Store secrets (generates INGEST_SECRET for you and prints it once)
npm run setup:secrets
#    …or one by one:
#    npx wrangler secret put INGEST_SECRET
#    npx wrangler secret put ROBLOX_OPEN_CLOUD_API_KEY   (optional)
#    npx wrangler secret put DASHBOARD_PASSWORD          (password mode only)
#    npx wrangler secret put SESSION_SECRET              (password mode only, 32+ chars)
#    npx wrangler secret put CF_API_TOKEN                (optional, "Account Analytics: Read")

# 4) Edit wrangler.jsonc "vars": ROBLOX_UNIVERSE_ID / ROBLOX_PLACE_ID / ROBLOX_GROUP_ID,
#    AUTH_MODE, ACCESS_TEAM_DOMAIN / ACCESS_AUD, CF_ACCOUNT_ID.
#    (IDs, timezone, goals and products can also be edited later in Admin.)

# 5) Build, migrate, deploy
npm run deploy
```

`wrangler deploy` prints your URL, e.g. `https://roadster-life-analytics.<subdomain>.workers.dev`.
The Roblox endpoint is that URL plus `/ingest`.

### Make it private

**Option A — Cloudflare Access (recommended, free for up to 50 users).**

1. In the Cloudflare dashboard go to **Zero Trust → Access → Applications → Add an
   application → Self-hosted**. Set the domain to your Worker hostname, path empty
   (whole site). Policy: **Allow** → *Emails* → your email.
2. Add a **second** self-hosted application for the same hostname with path `ingest`,
   policy action **Bypass** → *Everyone*. Roblox servers cannot log in. They
   authenticate with `INGEST_SECRET` instead, and the Worker rejects anything without it.
3. Copy the application's **Audience (AUD) tag** into `ACCESS_AUD`, and your team domain
   (e.g. `yourteam.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`. Keep
   `AUTH_MODE` set to `access`. Optionally set `ACCESS_ALLOWED_EMAILS`.
4. `npm run deploy`. The Worker verifies the Access JWT signature, audience, expiry
   and issuer on every API and WebSocket request, so a misconfigured Access policy
   still cannot expose data.

**Option B — password.** Set `"AUTH_MODE": "password"`, then set the `DASHBOARD_PASSWORD`
(12+ chars) and `SESSION_SECRET` (32+ chars) secrets. Sessions use HttpOnly,
Secure, SameSite=Strict HMAC-signed cookies. Logins are rate-limited (5/min per IP).

---

## 4. Connect Roadster Life (Roblox Studio)

Files live in `roblox/src/ServerScriptService/`. Nothing here modifies or replaces
your existing monetization scripts.

### 4.1 Where each script goes

| Instance (ServerScriptService) | Type | Source file |
|---|---|---|
| `RoadsterAnalytics` | **ModuleScript** | `RoadsterAnalytics/init.luau` |
| `RoadsterAnalytics` › `Config` | ModuleScript (child) | `RoadsterAnalytics/Config.luau` |
| `RoadsterAnalytics` › `Sha256` | ModuleScript (child) | `RoadsterAnalytics/Sha256.luau` |
| `RoadsterAnalyticsBootstrap` | **Script** (server) | `RoadsterAnalyticsBootstrap.server.luau` |

Copy each file's contents into a new instance with that exact name and type. If you
use Rojo, `roblox/default.project.json` maps them for you. Everything sits under
**ServerScriptService**, which is never replicated to players.

### 4.2 Enable HTTP requests

Studio → **Home → Game Settings → Security → Allow HTTP Requests: On** → Save. The
place must be published for the setting to apply to live servers.

### 4.3 Configure the endpoint

In `Config`, set:

```lua
Endpoint = "https://roadster-life-analytics.<subdomain>.workers.dev/ingest",
```

### 4.4 Configure authentication (secret never stored in the place)

1. Creator Hub → **Creations → Roadster Life → Secrets → Create secret**.
   - Name: `RoadsterAnalyticsIngest` (must match `Config.SecretName`)
   - Value: the `INGEST_SECRET` printed by `npm run setup:secrets`
   - Domain: your Worker hostname (e.g. `roadster-life-analytics.<subdomain>.workers.dev`)
2. For Studio play-tests, add the same name/value as a local Studio secret
   (**Game Settings → Security → Secrets**).

The module attaches it with `HttpService:GetSecret(...)`/`AddPrefix("Bearer ")`.
Scripts cannot read the value. If you cannot use the Secrets store, set
`Config.SigningSecret` to the same string instead. Requests are then HMAC-signed
(`X-RL-Timestamp` + `X-RL-Signature`), but anyone with edit access to the place can
read the string. `INGEST_REQUIRE_HMAC = "true"` makes the Worker accept only signed
requests.

### 4.5 Developer products: wrap your existing `ProcessReceipt`

Roblox allows only one `ProcessReceipt` callback per server, so the module never sets
it. In **your** script, change only the assignment line:

```lua
local Analytics = require(game:GetService("ServerScriptService"):WaitForChild("RoadsterAnalytics"))

-- before: MarketplaceService.ProcessReceipt = processReceipt
MarketplaceService.ProcessReceipt = Analytics.WrapProcessReceipt(processReceipt)
```

Your handler still runs with the same arguments, the same return value, and the same
errors. The wrapper never yields. It reports in a background thread *only* when your
handler returns `PurchaseGranted`. If you prefer explicit calls, put
`Analytics.ReportDeveloperProductPurchase(receiptInfo)` immediately before your own
`return Enum.ProductPurchaseDecision.PurchaseGranted`. See
`roblox/examples/ProcessReceipt.before-after.luau`.

### 4.6 Game passes

Nothing to change. With `Config.TrackGamePasses = true` the module listens to
`PromptGamePassPurchaseFinished` and ignores closed or cancelled prompts. Before
reporting a sale it confirms ownership with `UserOwnsGamePassAsync`. Your own
game-pass perk scripts keep working; multiple listeners are allowed.

### 4.7 Join/leave reporting

Automatic once `RoadsterAnalyticsBootstrap` runs `Analytics.Start()`. The module
handles:

- player joins and leaves
- a heartbeat with the full roster (repairs any lost events)
- a `server_close` event from `BindToClose`

### 4.8 Failure behaviour

- All HTTP runs in background threads inside `pcall`. An analytics outage cannot
  delay grants, break purchases, or crash a server.
- Failed batches retry with backoff, up to 60 s.
- Purchases that fail 3 times, or are rejected, are saved to the
  `RoadsterAnalyticsOutbox_v1` DataStore. Any server resends them later; the backend
  ignores duplicates by `PurchaseId`.

### 4.9 Test safely

1. Deploy the backend. Open **Admin → Roblox integration test** on the dashboard.
2. In Studio, press **Play**. Batches appear within ~1 s with the source **studio**.
   Studio traffic is stored separately and **never** counted in statistics.
   Toggle "Test events" in the activity feed to see it.
3. Buy a developer product in Studio (a test purchase; no Robux is charged). It shows
   up in the integration panel as a studio purchase.
4. Publish. Join the live game from the Roblox app and watch **LIVE PLAYERS** change.

---

## 5. Local development

```bash
cp .dev.vars.example .dev.vars          # development secrets (git-ignored)
npm run db:migrate:local
npm run dev                             # builds the UI and runs wrangler dev on :8787
#  optional hot-reload UI:   npm run dev:client   (proxies /api to :8787)
#  fake game servers (development mode only, every event marked SYNTHETIC):
node scripts/simulate-server.mjs --url http://127.0.0.1:8787 --secret <INGEST_SECRET from .dev.vars>
```

`APP_MODE=development` enables **Admin → Development test mode** and shows a
"Development mode" banner. Synthetic rows are stored with `source = 'synthetic'`, and
production (`APP_MODE=production`, the default) rejects them with HTTP 403.

## 6. Tests

```bash
npm test          # all suites
npm run test:worker   # Workers runtime (real D1 + Durable Objects via @cloudflare/vitest-plugin)
npm run test:client   # timezone/DST, reconnecting live client, budget, validation
npm run test:luau     # the Roblox module under real Luau (WASM) with mocked Roblox services
```

Coverage includes:

- duplicate and concurrent purchases, and resent batches
- joins and disconnects, plus roster reconciliation
- crashed servers, missing heartbeats, and servers that recover
- WebSocket push, keep-alive, and missed-event replay
- Durable Object eviction and persistence
- daily rollover and Los Angeles midnight and DST boundaries
- idempotent aggregation
- ingest and login rate limits
- authentication failures (bearer, HMAC, stale timestamps, forged cookies, Access JWT
  audience/expiry/allow-list, cross-origin requests)
- Roblox API 429/5xx/malformed/missing responses
- production rejection of synthetic data
- CSV formula injection
- that the Luau `ProcessReceipt` wrapper never yields or alters decisions
- outbox recovery, game-pass verification, and SHA-256/HMAC test vectors

## 7. Data model

`migrations/0001_init.sql` holds the tables:

- `purchases` (unique `dedupe_key`)
- `player_sessions`
- `daily_players`
- `server_sessions`
- `activity_events` (sequence-numbered for replay)
- `ccu_snapshots` (1/min)
- `official_snapshots`
- `daily_aggregates` (per timezone)
- `app_config`
- `products`

All timestamps are UTC milliseconds. Daily totals use the reporting timezone
(default `America/Los_Angeles`) and are **recomputed from raw rows**, never
incremented, so late or duplicate events cannot inflate them. Changing the timezone
rebuilds history in the background.

Retention:

| Data | Kept for |
|---|---|
| Purchases, daily aggregates | Forever |
| Sessions, servers | 180 days |
| Per-day unique players, CCU snapshots | 120 days |
| Official snapshots | 400 days |
| Activity feed | 30 days (configurable) |

## 8. Security summary

- Secrets live only in Worker secrets; the UI shows whether each is set, never its
  value. No Roblox cookies are used anywhere.
- Every `/api/*` request and WebSocket upgrade is authenticated (Access JWT or signed
  session cookie).
- State-changing requests and WebSocket upgrades must come from the dashboard's own
  origin.
- Ingestion checks:
  - bearer or HMAC credentials, compared in constant time
  - a ±5 min `sentAt` window and unique `batchId` (replay protection)
  - a 64 KB size cap and strict schema validation
  - text sanitisation
  - per-server (120/min) and global rate limits
  - a universe check
- Static assets are served with a strict CSP, `X-Frame-Options: DENY`, `no-referrer`
  and `noindex` (`public/_headers`).
