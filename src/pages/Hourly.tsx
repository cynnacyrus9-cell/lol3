import * as React from 'react'
import { RevenueChart, useRevenueSeries } from '@/components/charts/RevenueChart'
import { VisitsChart } from '@/components/charts/VisitsChart'
import type { VisitsSeries } from '@/components/charts/types'
import { rangeQuery, type RangeValue } from '@/components/RangePicker'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { useApi, useLive } from '@/state/live'
import { clock, num, robux } from '@/lib/format'

export function Hourly() {
  const { config, live } = useLive()
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const [preset, setPreset] = React.useState<'today' | 'yesterday'>('today')
  const range: RangeValue = { preset }
  const rev = useRevenueSeries(range)
  const visits = useApi<VisitsSeries>(`/api/series/visits?${rangeQuery(range)}`, [Math.floor((live?.today.trackedVisits ?? 0) / 5)])
  const rows = React.useMemo(() => {
    if (!rev.data || !visits.data) return []
    const v = new Map(visits.data.buckets.map((b) => [b.t, b]))
    const first = rev.data.firstTrackedAt
    return rev.data.buckets
      .filter((b) => first !== null && b.t + 3_600_000 > first)
      .map((b) => ({ t: b.t, revenue: b.revenue, sales: b.sales, tracked: v.get(b.t)?.tracked ?? 0, official: v.get(b.t)?.official ?? null }))
      .reverse()
  }, [rev.data, visits.data])
  const picker = (
    <Tabs value={preset} onValueChange={(p) => setPreset(p as 'today' | 'yesterday')}>
      <TabsList>
        <TabsTrigger value="today">Today</TabsTrigger>
        <TabsTrigger value="yesterday">Yesterday</TabsTrigger>
      </TabsList>
    </Tabs>
  )
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <RevenueChart range={range} controls={picker} height={240} />
        <VisitsChart range={range} height={240} />
      </div>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Hour by hour</CardTitle>
            <CardDescription>{preset === 'today' ? 'Today' : 'Yesterday'} in {tz}. Hours before tracking began are omitted.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {(rev.loading && !rev.data) || (visits.loading && !visits.data) ? (
            <Skeleton className="h-48 w-full" />
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No tracked hours yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-faint">
                    <th className="pb-2 font-medium">Hour</th>
                    <th className="pb-2 text-right font-medium">Robux</th>
                    <th className="pb-2 text-right font-medium">Sales</th>
                    <th className="pb-2 text-right font-medium">Tracked joins</th>
                    <th className="pb-2 text-right font-medium">Official visits</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.t} className="border-t border-line">
                      <td className="py-2 text-ink-2">
                        {clock(r.t, tz, false)} – {clock(r.t + 3_600_000, tz, false)}
                      </td>
                      <td className="mono py-2 text-right font-semibold">{robux(r.revenue)}</td>
                      <td className="mono py-2 text-right">{num(r.sales)}</td>
                      <td className="mono py-2 text-right">{num(r.tracked)}</td>
                      <td className="mono py-2 text-right text-ink-2">{r.official === null ? '—' : num(r.official)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
