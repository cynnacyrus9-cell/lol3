import * as React from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame, ChartTooltip, HEX } from './common'
import type { VisitsSeries } from './types'
import { rangeQuery, type RangeValue } from '@/components/RangePicker'
import { useApi, useLive } from '@/state/live'
import { clock, dateTime, num, shortDay } from '@/lib/format'

export function VisitsChart({ range, controls, height = 260 }: { range: RangeValue; controls?: React.ReactNode; height?: number }) {
  const { config, live } = useLive()
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const tick = Math.floor((live?.today.trackedVisits ?? 0) / 5) // refetch as visits accumulate
  const { data, loading, error } = useApi<VisitsSeries>(`/api/series/visits?${rangeQuery(range)}`, [tick])
  const hourly = data?.granularity === 'hour'
  const rows = React.useMemo(() => {
    if (!data) return []
    const first = data.firstTrackedAt
    return data.buckets.map((b) => ({ ...b, tracked: first !== null && b.t + (hourly ? 3_600_000 : 86_400_000) > first ? b.tracked : null }))
  }, [data, hourly])
  const hasOfficial = rows.some((r) => r.official !== null)
  return (
    <ChartFrame
      title="Visits"
      description={`New visits per ${hourly ? 'hour' : 'day'}`}
      source="live"
      updatedAt={live?.ingest.lastEventAt}
      sourceNote="Tracked visits are joins observed by the in-game integration. Official visits are differences between polled Roblox counters."
      loading={loading && !data}
      error={error}
      empty={!loading && !data?.firstTrackedAt && !hasOfficial}
      emptyText="Visit history begins once the integration or the official Roblox poller has collected data."
      height={height}
      controls={controls}
      legend={[
        { label: 'Tracked joins (in-game)', color: HEX.primary },
        ...(hasOfficial ? [{ label: 'Official Roblox visits (polled)', color: HEX.tertiary }] : []),
      ]}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} barGap={2}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" tickFormatter={(t, i) => (hourly ? clock(Number(t), tz, false) : rows[i]?.day ? shortDay(rows[i].day!) : '')} minTickGap={24} tickLine={false} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => num(v)} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
            content={(p) => (
              <ChartTooltip
                {...(p as object)}
                labelFormat={(l) => {
                  const r = rows.find((x) => x.t === Number(l))
                  return hourly ? dateTime(Number(l), tz) : r?.day ? shortDay(r.day) : String(l)
                }}
                valueFormat={(v) => (v === null || v === undefined ? 'no data' : num(v))}
              />
            )}
          />
          <Bar dataKey="tracked" name="Tracked joins" fill={HEX.primary} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          {hasOfficial ? <Bar dataKey="official" name="Official visits" fill={HEX.tertiary} radius={[4, 4, 0, 0]} isAnimationActive={false} /> : null}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
