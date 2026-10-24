import * as React from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame, ChartTooltip, HEX } from './common'
import type { RevenueSeries } from './types'
import { rangeQuery, type RangeValue } from '@/components/RangePicker'
import { useApi, useLive } from '@/state/live'
import { clock, dateTime, num, shortDay } from '@/lib/format'

export function useRevenueSeries(range: RangeValue) {
  const { revenueVersion } = useLive()
  return useApi<RevenueSeries>(`/api/series/revenue?${rangeQuery(range)}`, [revenueVersion])
}

export function RevenueChart({ range, controls, height = 260 }: { range: RangeValue; controls?: React.ReactNode; height?: number }) {
  const { config, live } = useLive()
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const { data, loading, error } = useRevenueSeries(range)
  const rows = React.useMemo(() => {
    if (!data) return []
    const first = data.firstTrackedAt
    return data.buckets.map((b) => {
      // Buckets before tracking began are unknown, not zero.
      const known = first !== null && b.t + (data.granularity === 'hour' ? 3_600_000 : 86_400_000) > first
      return { ...b, devProductRevenue: known ? b.devProductRevenue : null, gamePassRevenue: known ? b.gamePassRevenue : null }
    })
  }, [data])
  const hourly = data?.granularity === 'hour'
  const label = (t: number | string, row?: { day?: string }) => (hourly ? `${dateTime(Number(t), tz)}` : row?.day ? shortDay(row.day) : dateTime(Number(t), tz))
  return (
    <ChartFrame
      title="Robux revenue"
      description={hourly ? 'Gross Robux per hour from verified purchases' : 'Gross Robux per day from verified purchases'}
      source="live"
      updatedAt={live?.ingest.lastPurchaseAt}
      sourceNote="Updates the moment a verified purchase is received."
      loading={loading && !data}
      error={error}
      empty={!loading && !data?.firstTrackedAt}
      emptyText="Revenue appears after the first verified purchase is reported by your game."
      height={height}
      controls={controls}
      legend={[
        { label: 'Developer products', color: HEX.primary },
        { label: 'Game passes', color: HEX.secondary },
      ]}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -6 }} barCategoryGap="18%">
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="t"
            tickFormatter={(t, i) => (hourly ? clock(Number(t), tz, false) : rows[i]?.day ? shortDay(rows[i].day!) : '')}
            minTickGap={24}
            tickLine={false}
          />
          <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={(v) => num(v)} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
            content={(p) => (
              <ChartTooltip
                {...(p as object)}
                labelFormat={(l) => label(l, rows.find((r) => r.t === Number(l)))}
                valueFormat={(v) => (v === null || v === undefined ? 'not tracked' : `R$ ${num(v)}`)}
              />
            )}
          />
          <Bar dataKey="devProductRevenue" name="Developer products" stackId="r" fill={HEX.primary} stroke={HEX.surface} strokeWidth={1} isAnimationActive={false} />
          <Bar dataKey="gamePassRevenue" name="Game passes" stackId="r" fill={HEX.secondary} stroke={HEX.surface} strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
