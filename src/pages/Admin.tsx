import * as React from 'react'
import { CheckCircle2, CircleSlash, FlaskConical, KeyRound, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import type { ProductConfig, PublicConfig } from '@shared/types'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label, Select } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { apiPost } from '@/lib/api'
import { useApi, useLive, useNow } from '@/state/live'
import { dateTime, num, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

interface UsageResponse {
  report: {
    day: string
    resetsAt: number
    metrics: { key: string; label: string; used: number; limit: number; projected: number; pct: number; projectedPct: number; note: string }[]
    counters: {
      worker: Record<string, number>
      doRequests: { fetch: number; alarm: number }
      wsMessagesIn: number
      doStorage: { reads: number; writes: number }
      roblox: { requests: number; errors: number; rateLimited: number }
      ingest: { batches: number; events: number; duplicates: number; rejected: number }
    }
  }
  budget: { level: string; heartbeatSec: number; flushSec: number; joinLeaveLogging: boolean; messages: string[] }
  cloudflare: { fetchedAt: number; workerRequests: number | null; doRequests: number | null; d1RowsRead: number | null; d1RowsWritten: number | null; error: string | null } | null
  cloudflareConfigured: boolean
  viewers: number
  liveServers: number
}

interface IntegrationResponse {
  servers: { jobId: string; source: string; players: number; lastSeenAt: number; startedAt: number; heartbeatSec: number; placeVersion: number | null }[]
  recentBatches: { at: number; jobId: string; source: string; events: number; players: number | null; accepted: number; duplicates: number; status: number; error?: string }[]
  ingestSecretConfigured: boolean
  requireHmac: boolean
  universeId: string | null
}

function Section({ title, description, children, actions }: { title: string; description?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Notice({ kind, children }: { kind: 'ok' | 'error'; children: React.ReactNode }) {
  return (
    <div className={cn('mt-3 rounded-lg border px-3 py-2 text-[13px]', kind === 'ok' ? 'border-good/30 bg-good/10 text-[#39d239]' : 'border-critical/30 bg-critical/10 text-[#ff9b9b]')} role="status">
      {children}
    </div>
  )
}

export function Admin() {
  const { config, live } = useLive()
  if (!config) return <Skeleton className="h-96 w-full" />
  return (
    <div className="space-y-5">
      <SettingsForm config={config} />
      <ProductsEditor config={config} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <SecretsPanel config={config} />
        <UsagePanel />
      </div>
      <IntegrationPanel />
      {live?.mode === 'development' ? <SyntheticPanel /> : null}
    </div>
  )
}

function SettingsForm({ config }: { config: PublicConfig }) {
  const { setConfig } = useLive()
  const [form, setForm] = React.useState({
    gameName: config.gameName,
    universeId: config.universeId ?? '',
    placeId: config.placeId ?? '',
    groupId: config.groupId ?? '',
    timezone: config.timezone,
    dailyGoalRobux: config.dailyGoalRobux ? String(config.dailyGoalRobux) : '',
    milestones: config.milestones.join(', '),
    netRevenueRate: String(Math.round(config.netRevenueRate * 100)),
    officialPollSec: String(config.officialPollSec),
    activityRetentionDays: String(config.activityRetentionDays),
  })
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const zones = React.useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [config.timezone]
    } catch {
      return [config.timezone]
    }
  }, [config.timezone])

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const milestones = form.milestones
        .split(/[,\s]+/)
        .filter(Boolean)
        .map((x) => Number(x))
      const r = await apiPost<{ config: PublicConfig }>('/api/admin/config', {
        gameName: form.gameName,
        universeId: form.universeId || null,
        placeId: form.placeId || null,
        groupId: form.groupId || null,
        timezone: form.timezone,
        dailyGoalRobux: form.dailyGoalRobux ? Number(form.dailyGoalRobux) : null,
        milestones,
        netRevenueRate: Number(form.netRevenueRate) / 100,
        officialPollSec: Number(form.officialPollSec),
        activityRetentionDays: Number(form.activityRetentionDays),
      })
      setConfig(r.config)
      setMsg({ kind: 'ok', text: 'Settings saved.' })
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const lookup = async () => {
    setMsg(null)
    try {
      const r = await apiPost<{ universeId: string }>('/api/admin/lookup-universe', { placeId: form.placeId })
      setForm((f) => ({ ...f, universeId: r.universeId }))
      setMsg({ kind: 'ok', text: `Place ${form.placeId} belongs to universe ${r.universeId}. Save to apply.` })
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message })
    }
  }

  const verifyKey = async () => {
    setMsg(null)
    try {
      const r = await apiPost<{ universe: { displayName: string | null; visibility: string | null } }>('/api/admin/verify-open-cloud', {})
      setMsg({ kind: 'ok', text: `Open Cloud key works: "${r.universe.displayName ?? 'unnamed'}" (${r.universe.visibility ?? 'unknown visibility'}).` })
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message })
    }
  }

  const pollNow = async () => {
    setMsg(null)
    try {
      const r = await apiPost<{ official: { visits: number | null } }>('/api/admin/poll-official', {})
      setMsg({ kind: 'ok', text: `Official visits: ${num(r.official.visits)}` })
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message })
    }
  }

  const field = (label: string, key: keyof typeof form, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`f-${key}`}>{label}</Label>
      <Input id={`f-${key}`} value={form[key]} onChange={set(key)} {...props} />
      {hint ? <p className="text-[11px] text-faint">{hint}</p> : null}
    </div>
  )

  return (
    <Section
      title="Game & reporting settings"
      description="Stored in D1. Secrets (API keys, ingest secret) are never entered here — see “Secrets”."
      actions={
        <Button onClick={save} disabled={busy}>
          <Save /> Save
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {field('Game name', 'gameName')}
        <div className="space-y-1.5">
          <Label htmlFor="f-placeId">Roblox Place ID</Label>
          <div className="flex gap-2">
            <Input id="f-placeId" inputMode="numeric" value={form.placeId} onChange={set('placeId')} />
            <Button variant="secondary" onClick={lookup} disabled={!form.placeId}>
              Find universe
            </Button>
          </div>
        </div>
        {field('Roblox Universe ID', 'universeId', { inputMode: 'numeric' }, 'Used for official visits and to reject events from other experiences.')}
        {field('Roblox Group ID', 'groupId', { inputMode: 'numeric' }, 'Optional; for reference when the experience is group-owned.')}
        <div className="space-y-1.5">
          <Label htmlFor="f-timezone">Reporting timezone</Label>
          <Select id="f-timezone" value={form.timezone} onChange={set('timezone')} className="w-full">
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
          <p className="text-[11px] text-faint">Daily totals reset at local midnight. Changing it rebuilds daily history in the background.</p>
        </div>
        {field('Daily revenue goal (Robux)', 'dailyGoalRobux', { inputMode: 'numeric', placeholder: 'none' })}
        {field('Revenue milestones (all-time Robux)', 'milestones', {}, 'Comma separated. You get a notification when each is crossed.')}
        {field('Creator share for net estimate (%)', 'netRevenueRate', { inputMode: 'numeric' }, 'Shown only as an estimate.')}
        {field('Official API poll interval (s)', 'officialPollSec', { inputMode: 'numeric' }, 'While a dashboard is open (min 20 s). Idle: every 5 min.')}
        {field('Activity feed retention (days)', 'activityRetentionDays', { inputMode: 'numeric' })}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={pollNow}>
          <RefreshCw /> Poll official stats now
        </Button>
        <Button variant="secondary" size="sm" onClick={verifyKey} disabled={!config.secrets.ROBLOX_OPEN_CLOUD_API_KEY}>
          <KeyRound /> Test Open Cloud API key
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            apiPost('/api/admin/recompute', {})
              .then(() => setMsg({ kind: 'ok', text: "Today's totals were recomputed from stored events." }))
              .catch((e: Error) => setMsg({ kind: 'error', text: e.message }))
          }
        >
          <RefreshCw /> Recompute today from raw events
        </Button>
      </div>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
    </Section>
  )
}

function ProductsEditor({ config }: { config: PublicConfig }) {
  const { setConfig } = useLive()
  const [rows, setRows] = React.useState<(Omit<ProductConfig, 'productId' | 'priceRobux'> & { productId: string; priceRobux: string })[]>(
    config.products.map((p) => ({ ...p, productId: String(p.productId), priceRobux: p.priceRobux === null ? '' : String(p.priceRobux) })),
  )
  const [msg, setMsg] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const update = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const save = async () => {
    setMsg(null)
    try {
      const r = await apiPost<{ config: PublicConfig }>('/api/admin/products', {
        products: rows.filter((r) => r.productId).map((r) => ({ kind: r.kind, productId: Number(r.productId), name: r.name || null, priceRobux: r.priceRobux === '' ? null : Number(r.priceRobux) })),
      })
      setConfig(r.config)
      setMsg({ kind: 'ok', text: 'Products saved. Missing names/prices are filled in by your game servers via GetProductInfo.' })
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message })
    }
  }
  return (
    <Section
      title="Developer products & game passes"
      description="IDs you sell. Names make charts readable; amounts always come from the verified purchase."
      actions={
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setRows((r) => [...r, { kind: 'developer_product', productId: '', name: '', priceRobux: '' }])}>
            <Plus /> Add
          </Button>
          <Button size="sm" onClick={save}>
            <Save /> Save products
          </Button>
        </div>
      }
    >
      {rows.length === 0 ? <p className="text-sm text-muted">No products configured yet. Purchases are still recorded; add IDs to label them.</p> : null}
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 md:grid-cols-[180px_160px_1fr_120px_40px]">
            <Select aria-label="Type" value={r.kind} onChange={(e) => update(i, { kind: e.target.value as ProductConfig['kind'] })}>
              <option value="developer_product">Developer product</option>
              <option value="game_pass">Game pass</option>
            </Select>
            <Input aria-label="ID" placeholder="ID" inputMode="numeric" value={r.productId} onChange={(e) => update(i, { productId: e.target.value.replace(/\D/g, '') })} />
            <Input aria-label="Name" placeholder="Name (optional)" value={r.name ?? ''} onChange={(e) => update(i, { name: e.target.value })} />
            <Input aria-label="Price" placeholder="Price R$" inputMode="numeric" value={r.priceRobux} onChange={(e) => update(i, { priceRobux: e.target.value.replace(/\D/g, '') })} />
            <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : null}
    </Section>
  )
}

const SECRET_HELP: Record<string, string> = {
  INGEST_SECRET: 'Authenticates your Roblox servers (Roblox Secrets store value must match).',
  ROBLOX_OPEN_CLOUD_API_KEY: 'Optional. Used only to verify the universe via Open Cloud.',
  DASHBOARD_PASSWORD: 'Password sign-in (only when AUTH_MODE = password).',
  SESSION_SECRET: 'Signs dashboard session cookies (password mode).',
  CF_API_TOKEN: 'Optional. Account Analytics: Read — shows official Cloudflare usage below.',
}

function SecretsPanel({ config }: { config: PublicConfig }) {
  return (
    <Section title="Secrets & authentication" description="Values are stored as encrypted Worker secrets and never sent to the browser.">
      <ul className="divide-y divide-line">
        {Object.entries(config.secrets).map(([k, set]) => (
          <li key={k} className="flex items-start gap-3 py-2.5">
            {set ? <CheckCircle2 className="mt-0.5 size-4 text-[#39d239]" aria-label="Configured" /> : <CircleSlash className="mt-0.5 size-4 text-faint" aria-label="Not set" />}
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[12px] text-ink">{k}</div>
              <div className="text-[11px] text-muted">{SECRET_HELP[k]}</div>
            </div>
            <Badge variant={set ? 'good' : 'outline'}>{set ? 'set' : 'not set'}</Badge>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[12px] text-muted">
        Set or rotate with <code className="rounded bg-raised px-1 py-0.5 text-ink-2">npx wrangler secret put NAME</code>. Dashboard sign-in mode: <b className="text-ink-2">{config.authMode}</b>.
      </p>
    </Section>
  )
}

function Bar({ pct, projectedPct }: { pct: number; projectedPct: number }) {
  const color = projectedPct > 0.9 ? 'bg-critical' : projectedPct > 0.7 ? 'bg-warning' : 'bg-accent'
  return (
    <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="absolute inset-y-0 left-0 bg-white/10" style={{ width: `${Math.min(100, projectedPct * 100)}%` }} />
      <div className={cn('absolute inset-y-0 left-0 rounded-full', color)} style={{ width: `${Math.min(100, pct * 100)}%` }} />
    </div>
  )
}

function UsagePanel() {
  const now = useNow(30_000)
  const [refresh, setRefresh] = React.useState(0)
  const { data, loading, error } = useApi<UsageResponse>(`/api/admin/usage${refresh ? '?refresh=1' : ''}`, [Math.floor(now / 60_000), refresh])
  return (
    <Section
      title="Cloudflare free-tier usage (today, UTC)"
      description="Estimated by the backend from its own counters; D1 rows are exact."
      actions={
        <Button variant="ghost" size="sm" onClick={() => setRefresh((r) => r + 1)}>
          <RefreshCw /> Refresh
        </Button>
      }
    >
      {loading && !data ? (
        <Skeleton className="h-48 w-full" />
      ) : error ? (
        <Notice kind="error">{error}</Notice>
      ) : data ? (
        <div className="space-y-4">
          {data.report.metrics.map((m) => (
            <div key={m.key}>
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="font-medium text-ink">{m.label}</span>
                <span className="tabular text-ink-2">
                  {num(m.used)} / {num(m.limit)} <span className="text-faint">· projected {num(m.projected)} ({Math.round(m.projectedPct * 100)}%)</span>
                </span>
              </div>
              <Bar pct={m.pct} projectedPct={m.projectedPct} />
              <p className="mt-1 text-[11px] text-faint">{m.note}</p>
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2 text-[12px] text-ink-2 sm:grid-cols-3">
            <span>Ingest batches: {num(data.report.counters.ingest.batches)}</span>
            <span>Duplicates ignored: {num(data.report.counters.ingest.duplicates)}</span>
            <span>Rejected: {num(data.report.counters.ingest.rejected)}</span>
            <span>Alarms: {num(data.report.counters.doRequests.alarm)}</span>
            <span>WS messages in: {num(data.report.counters.wsMessagesIn)}</span>
            <span>Roblox API calls: {num(data.report.counters.roblox.requests)}</span>
            <span>Viewers now: {num(data.viewers)}</span>
            <span>Heartbeat: {data.budget.heartbeatSec}s</span>
            <span>Batching: {data.budget.flushSec}s</span>
          </div>
          <div className={cn('rounded-lg border px-3 py-2 text-[12px]', data.budget.level === 'ok' ? 'border-line text-muted' : 'border-warning/40 bg-warning/10 text-warning')}>
            Budget level: <b>{data.budget.level}</b>. {data.budget.messages.join(' ') || 'Within free-tier limits.'} Resets {dateTime(data.report.resetsAt, Intl.DateTimeFormat().resolvedOptions().timeZone)}.
          </div>
          {data.cloudflareConfigured ? (
            <div className="rounded-lg border border-line p-3 text-[12px] text-ink-2">
              <div className="mb-1 font-medium text-ink">Official Cloudflare analytics (GraphQL)</div>
              {data.cloudflare?.error ? (
                <span className="text-[#ff9b9b]">{data.cloudflare.error}</span>
              ) : (
                <div className="grid grid-cols-2 gap-1">
                  <span>Worker requests: {num(data.cloudflare?.workerRequests)}</span>
                  <span>DO requests: {num(data.cloudflare?.doRequests)}</span>
                  <span>D1 rows read: {num(data.cloudflare?.d1RowsRead)}</span>
                  <span>D1 rows written: {num(data.cloudflare?.d1RowsWritten)}</span>
                  <span className="col-span-2 text-faint">Fetched {timeAgo(data.cloudflare?.fetchedAt, now)} (analytics lag a few minutes)</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-faint">Set CF_ACCOUNT_ID and the CF_API_TOKEN secret to also show Cloudflare's official usage numbers.</p>
          )}
        </div>
      ) : null}
    </Section>
  )
}

function IntegrationPanel() {
  const now = useNow(5000)
  const { live } = useLive()
  const { data, loading, refresh } = useApi<IntegrationResponse>('/api/admin/integration', [live?.ingest.lastEventAt, Math.floor(now / 15_000)])
  return (
    <Section
      title="Roblox integration test"
      description="Recent batches received from game servers, including Roblox Studio play-tests (which never count toward statistics)."
      actions={
        <Button variant="ghost" size="sm" onClick={refresh}>
          <RefreshCw /> Refresh
        </Button>
      }
    >
      {loading && !data ? (
        <Skeleton className="h-32 w-full" />
      ) : data ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2 text-[12px]">
            <Badge variant={data.ingestSecretConfigured ? 'good' : 'critical'}>{data.ingestSecretConfigured ? 'Ingest secret set' : 'INGEST_SECRET missing'}</Badge>
            <Badge variant="outline">{data.requireHmac ? 'HMAC required' : 'Bearer (Secrets store) or HMAC accepted'}</Badge>
            <Badge variant={data.universeId ? 'accent' : 'warning'}>{data.universeId ? `Universe ${data.universeId}` : 'Universe not set'}</Badge>
          </div>
          {data.recentBatches.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No batches received since the backend last restarted. Start a play-test in Roblox Studio with HTTP requests enabled.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[12px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-faint">
                    <th className="pb-2 font-medium">Received</th>
                    <th className="pb-2 font-medium">Server</th>
                    <th className="pb-2 font-medium">Source</th>
                    <th className="pb-2 text-right font-medium">Events</th>
                    <th className="pb-2 text-right font-medium">Roster</th>
                    <th className="pb-2 text-right font-medium">Duplicates</th>
                    <th className="pb-2 text-right font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentBatches.map((b, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="tabular py-1.5 text-ink-2">{timeAgo(b.at, now)}</td>
                      <td className="py-1.5 font-mono text-ink-2">{b.jobId.slice(0, 18)}</td>
                      <td className="py-1.5">{b.source === 'live' ? <Badge variant="outline">live</Badge> : <Badge variant="warning">{b.source}</Badge>}</td>
                      <td className="tabular py-1.5 text-right">{b.events}</td>
                      <td className="tabular py-1.5 text-right">{b.players ?? '—'}</td>
                      <td className="tabular py-1.5 text-right">{b.duplicates}</td>
                      <td className="py-1.5 text-right">
                        {b.status === 200 ? <span className="text-[#39d239]">200 OK</span> : <span className="text-[#ff9b9b]" title={b.error}>{b.status} {b.error}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </Section>
  )
}

function SyntheticPanel() {
  const [msg, setMsg] = React.useState<string | null>(null)
  const act = (action: string) =>
    apiPost<{ ok: boolean; error?: string }>('/api/admin/synthetic', { action })
      .then((r) => setMsg(r.ok ? `Synthetic "${action}" sent through the real ingestion pipeline.` : r.error ?? 'failed'))
      .catch((e: Error) => setMsg(e.message))
  return (
    <Section title="Development test mode" description="Generates events labelled SYNTHETIC. Disabled (HTTP 403) when APP_MODE is production.">
      <div className="flex flex-wrap gap-2">
        {['join', 'leave', 'purchase', 'close'].map((a) => (
          <Button key={a} variant="secondary" size="sm" onClick={() => act(a)}>
            <FlaskConical /> Synthetic {a}
          </Button>
        ))}
      </div>
      {msg ? <p className="mt-3 text-[12px] text-warning">{msg}</p> : null}
    </Section>
  )
}
