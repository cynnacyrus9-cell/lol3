import * as React from 'react'
import { Crown, ExternalLink } from 'lucide-react'
import { RangePicker, rangeQuery, type RangeValue } from '@/components/RangePicker'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useApi, useLive, useNow } from '@/state/live'
import { num, robux, timeAgo } from '@/lib/format'
import { dayKey } from '@shared/time'

interface SpendersResponse {
  spenders: { userId: number; username: string | null; robux: number; purchases: number; lastAt: number; firstAt: number }[]
}

export function TopSpenders() {
  const { config, revenueVersion } = useLive()
  const now = useNow(30_000)
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const [range, setRange] = React.useState<RangeValue>({ preset: '30d' })
  const { data, loading, error } = useApi<SpendersResponse>(`/api/top-spenders?${rangeQuery(range)}`, [revenueVersion])
  const total = data?.spenders.reduce((a, s) => a + s.robux, 0) ?? 0
  const top = data?.spenders[0]?.robux ?? 0
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Top spenders</CardTitle>
          <CardDescription>Players ranked by verified Robux spent (developer products + in-experience game passes)</CardDescription>
        </div>
        <RangePicker value={range} onChange={setRange} today={dayKey(now, tz)} />
      </CardHeader>
      <CardContent>
        {loading && !data ? (
          <Skeleton className="h-64 w-full" />
        ) : error ? (
          <p className="text-sm text-[#ff9b9b]">{error}</p>
        ) : !data?.spenders.length ? (
          <p className="py-10 text-center text-sm text-muted">No purchases in this range yet.</p>
        ) : (
          <ol className="divide-y divide-line">
            {data.spenders.map((s, i) => (
              <li key={s.userId} className="flex items-center gap-3 py-2.5">
                <span className={`mono grid size-8 shrink-0 place-items-center rounded-lg text-[13px] font-bold ${i === 0 ? 'bg-warning/15 text-warning' : 'bg-raised text-ink-2'}`}>
                  {i === 0 ? <Crown className="size-4" aria-label="Top spender" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate text-[13px] font-semibold text-ink">
                    {s.username ?? `User ${s.userId}`}
                    <a href={`https://www.roblox.com/users/${s.userId}/profile`} target="_blank" rel="noopener noreferrer" className="text-faint hover:text-accent" aria-label="Open Roblox profile">
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full bg-[var(--color-series-1)]" style={{ width: `${top ? (s.robux / top) * 100 : 0}%` }} />
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {num(s.purchases)} purchase{s.purchases === 1 ? '' : 's'} · last {timeAgo(s.lastAt, now)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="mono text-[15px] font-bold text-ink">{robux(s.robux)}</div>
                  <div className="text-[11px] text-muted">{total ? `${((s.robux / total) * 100).toFixed(1)}% of top 50` : ''}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
