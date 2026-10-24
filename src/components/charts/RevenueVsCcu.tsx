import * as React from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame, ChartTooltip, HEX } from './common'
import type { CcuSeries } from './types'
import { useRevenueSeries } from './RevenueChart'
import { useApi, useLive } from '@/state/live'
import { clock, dateTime, num } from '@/lib/format'
import { hourBucketStart } from '@shared/time'

/**
 * Two aligned charts sharing one time axis (no dual y-axis): Robux per hour on
 * top, average tracked CCU per hour below, synced hover.
 */
export function RevenueVsCcu() {
  const { config, live } = useLive()
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const rev = useRevenueSeries({ preset: 'today' })
  const minute10 = Math.floor((live?.serverTime ?? Date.now()) / 600_000)
  const ccu = useApi<CcuSeries>('/api/series/ccu?window=24h', [minute10])
  const rows = React.useMemo(() => {
    if (!rev.data || !ccu.data) return []
    const byHour = new Map<number, { sum: number; n: number }>()
    for (const p of ccu.data.points) {
      const h = hourBucketStart(p.t, tz)
      const cur = byHour.get(h) ?? { sum: 0, n: 0 }
      cur.sum += p.ccu
      cur.n += 1
      byHour.set(h, cur)
    }
    return rev.data.buckets.map((b) => {
      const c = byHour.get(b.t)
      const perPlayer = c && c.sum > 0 ? b.revenue / (c.sum / c.n) : null
      return { t: b.t, revenue: b.revenue, avgCcu: c ? Math.round((c.sum / c.n) * 10) / 10 : null, perPlayer }
    })
  }, [rev.data, ccu.data, tz])
  const loading = (rev.loading && !rev.data) || (ccu.loading && !ccu.data)
  const empty = !loading && (!rev.data?.firstTrackedAt || rows.every((r) => r.avgCcu === null))
  const label = (l: number | string) => dateTime(Number(l), tz)
  return (
    <ChartFrame
      title="Revenue vs. concurrent players (today)"
      description="Same hours, two scales: Robux earned (top) and average tracked CCU (bottom)"
      source="computed"
      loading={loading}
      error={rev.error ?? ccu.error}
      empty={empty}
      emptyText="Needs both CCU history and revenue for today."
      height={300}
    >
      <div className="flex h-full flex-col gap-1">
        <div className="h-1/2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} syncId="rev-ccu" margin={{ top: 4, right: 8, bottom: 0, left: -6 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="t" hide />
              <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={(v) => num(v)} />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                content={(p) => <ChartTooltip {...(p as object)} labelFormat={label} valueFormat={(v) => `R$ ${num(v)}`} />}
              />
              <Bar dataKey="revenue" name="Robux / hour" fill={HEX.primary} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="h-1/2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} syncId="rev-ccu" margin={{ top: 4, right: 8, bottom: 0, left: -6 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="t" tickFormatter={(t) => clock(Number(t), tz, false)} minTickGap={24} tickLine={false} />
              <YAxis tickLine={false} axisLine={false} width={52} allowDecimals={false} />
              <Tooltip
                content={(p) => (
                  <ChartTooltip
                    {...(p as object)}
                    labelFormat={label}
                    valueFormat={(v, key) => (key === 'avgCcu' ? `${num(v, 1)} players` : String(v))}
                  />
                )}
              />
              <Line dataKey="avgCcu" name="Avg CCU" stroke={HEX.tertiary} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </ChartFrame>
  )
}
