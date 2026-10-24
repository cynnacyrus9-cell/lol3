import { CheckCircle2, CircleSlash, Clock3, AlertTriangle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useLive, useNow } from '@/state/live'
import { dateTime, num, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

type Avail = 'live' | 'delayed' | 'estimate' | 'unavailable'

const AVAIL: Record<Avail, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  live: { label: 'Live', icon: CheckCircle2, cls: 'text-[#39d239]' },
  delayed: { label: 'Delayed', icon: Clock3, cls: 'text-accent' },
  estimate: { label: 'Estimate', icon: AlertTriangle, cls: 'text-warning' },
  unavailable: { label: 'Unavailable', icon: CircleSlash, cls: 'text-faint' },
}

function AvailPill({ a }: { a: Avail }) {
  const m = AVAIL[a]
  const Icon = m.icon
  return (
    <span className={cn('inline-flex items-center gap-1 text-[12px] font-medium', m.cls)}>
      <Icon className="size-3.5" aria-hidden /> {m.label}
    </span>
  )
}

export function DataSources() {
  const { live, connection, lastMessageAt, config } = useLive()
  const now = useNow(1000)
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const o = live?.official
  const flush = live?.budget.flushSec ?? 1
  const rows: { metric: string; avail: Avail; source: string; latency: string; updated?: number | null; note?: string }[] = [
    { metric: 'Live players (CCU), players per server', avail: 'live', source: 'PlayerAdded / PlayerRemoving + heartbeats from each game server', latency: `≈${flush <= 1 ? '1' : flush} s after the event, then <1 s to the dashboard`, updated: live?.serverTime },
    { metric: 'Joins, leaves, session duration', avail: 'live', source: 'In-game events; heartbeats repair missed events; crashed servers closed after missed heartbeats', latency: `≈${flush <= 1 ? '1' : flush} s`, updated: live?.ingest.lastEventAt },
    { metric: 'Tracked visits & unique players', avail: 'live', source: 'Joins observed since the integration was installed', latency: 'Live', updated: live?.ingest.lastEventAt, note: 'Not historical Roblox visits.' },
    { metric: 'Developer product purchases', avail: 'live', source: 'Your ProcessReceipt handler after PurchaseGranted; amount = receipt CurrencySpent; deduplicated by PurchaseId', latency: 'Sent immediately (<1 s)', updated: live?.ingest.lastPurchaseAt },
    { metric: 'Game pass purchases (in experience)', avail: 'live', source: 'PromptGamePassPurchaseFinished(wasPurchased) + UserOwnsGamePassAsync verification; amount = list price', latency: '1–3 s (ownership check)', updated: live?.ingest.lastPurchaseAt },
    { metric: 'Developer products bought from the Store tab', avail: 'delayed', source: 'Roblox runs ProcessReceipt when the buyer next joins a server', latency: 'When the buyer joins', note: 'Counted at the time it is granted.' },
    { metric: 'Game passes bought outside the experience', avail: 'unavailable', source: 'Roblox sends no event to game servers for website purchases', latency: '—', note: 'Never estimated or fabricated.' },
    { metric: 'Official total visits', avail: o?.status === 'unavailable' ? 'unavailable' : 'delayed', source: 'games.roblox.com/v1/games (polled by one shared backend job)', latency: `Polled every ${o?.pollSec ?? 30} s while a dashboard is open; Roblox refreshes the counter on its own schedule`, updated: o?.fetchedAt, note: o?.lastError ?? undefined },
    { metric: 'Official "playing" count & favorites', avail: o?.status === 'unavailable' ? 'unavailable' : 'delayed', source: 'Same official response', latency: `Every ${o?.pollSec ?? 30} s`, updated: o?.fetchedAt },
    { metric: 'Gross Robux revenue', avail: 'live', source: 'Sum of verified purchases above', latency: 'Live', updated: live?.ingest.lastPurchaseAt },
    { metric: 'Net earnings', avail: 'estimate', source: `Gross × ${Math.round((live?.netRevenueRate ?? 0.7) * 100)}% (configurable)`, latency: '—', note: 'Confirmed net is not available from a supported Roblox API.' },
    { metric: 'Pending Robux', avail: 'unavailable', source: 'No supported Open Cloud endpoint; account-cookie APIs are deliberately not used', latency: '—' },
    { metric: 'Earnings/visits before installation', avail: 'unavailable', source: 'Not tracked; only the official cumulative visit counter covers history', latency: '—' },
  ]
  const ws = connection.state
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Health
          title="Dashboard connection"
          ok={ws === 'live' || ws === 'fallback'}
          lines={[
            `State: ${ws}${connection.transport ? ` (${connection.transport === 'ws' ? 'WebSocket' : 'Server-Sent Events'})` : ''}`,
            `Last message: ${timeAgo(lastMessageAt, now)}`,
            connection.attempts ? `Reconnect attempts: ${connection.attempts}` : 'Keep-alive ping every 25 s',
          ]}
        />
        <Health
          title="Roblox in-game events"
          ok={live?.ingest.status === 'live'}
          warn={live?.ingest.status === 'waiting'}
          lines={[
            `Status: ${live?.ingest.status ?? '—'}`,
            `Reporting servers: ${num(live?.activeServers)}`,
            `Last event: ${timeAgo(live?.ingest.lastEventAt, now)} · last heartbeat: ${timeAgo(live?.ingest.lastHeartbeatAt, now)}`,
          ]}
        />
        <Health
          title="Roblox official API"
          ok={o?.status === 'delayed'}
          warn={o?.status === 'waiting' || o?.status === 'unavailable'}
          lines={[
            `Status: ${o?.status ?? '—'}`,
            `Last fetch: ${o?.fetchedAt ? dateTime(o.fetchedAt, tz) : 'never'}`,
            o?.lastError ? `Last error: ${o.lastError}` : `Next poll: ${o?.nextPollAt ? `in ${Math.max(0, Math.round((o.nextPollAt - now) / 1000))} s` : '—'}`,
          ]}
        />
      </div>
      {live && live.budget.level !== 'ok' ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          <b>Free-tier protection active ({live.budget.level}).</b> {live.budget.messages.join(' ')}
        </div>
      ) : null}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>What is live, delayed or unavailable</CardTitle>
            <CardDescription>Every number on this dashboard comes from one of these sources. Nothing is simulated in production.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-faint">
                <th className="pb-2 font-medium">Metric</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Source</th>
                <th className="pb-2 font-medium">Latency</th>
                <th className="pb-2 text-right font-medium">Last updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.metric} className="border-t border-line align-top">
                  <td className="py-2.5 pr-3 font-medium text-ink">{r.metric}</td>
                  <td className="py-2.5 pr-3">
                    <AvailPill a={r.avail} />
                  </td>
                  <td className="py-2.5 pr-3 text-ink-2">
                    {r.source}
                    {r.note ? <div className="text-[11px] text-muted">{r.note}</div> : null}
                  </td>
                  <td className="py-2.5 pr-3 text-ink-2">{r.latency}</td>
                  <td className="tabular py-2.5 text-right text-muted">{r.updated ? timeAgo(r.updated, now) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}

function Health({ title, ok, warn, lines }: { title: string; ok: boolean; warn?: boolean; lines: string[] }) {
  const Icon = ok ? CheckCircle2 : warn ? Clock3 : AlertTriangle
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <Icon className={cn('size-4', ok ? 'text-[#39d239]' : warn ? 'text-warning' : 'text-[#ff7b7b]')} aria-hidden />
        <span className="text-sm font-semibold">{title}</span>
        <span className={cn('ml-auto text-[11px] font-semibold', ok ? 'text-[#39d239]' : warn ? 'text-warning' : 'text-[#ff7b7b]')}>{ok ? 'Healthy' : warn ? 'Waiting' : 'Attention'}</span>
      </div>
      <ul className="mt-2 space-y-0.5 text-[12px] text-ink-2">
        {lines.map((l) => (
          <li key={l} className="break-words">
            {l}
          </li>
        ))}
      </ul>
    </Card>
  )
}
