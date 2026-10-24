import * as React from 'react'
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame, ChartTooltip, HEX } from './common'
import type { CcuSeries } from './types'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useApi, useLive } from '@/state/live'
import { clock, dateTime, num } from '@/lib/format'

const WINDOWS = ['5m', '15m', '1h', '6h', '24h', '7d'] as const
export type Win = (typeof WINDOWS)[number]
const SPAN: Record<Win, number> = { '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3 }

export function CcuChart({
  height = 260,
  defaultWindow = '1h',
  windows = WINDOWS,
  title = 'Live player activity',
  description = 'Concurrent players reported by your game servers',
}: {
  height?: number
  defaultWindow?: Win
  windows?: readonly Win[]
  title?: string
  description?: string
}) {
  const { live, ccuTrail, config } = useLive()
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const [win, setWin] = React.useState<Win>(defaultWindow)
  // Re-fetch stored history once a minute (new snapshot rows); live points come over the WebSocket.
  const minute = Math.floor((live?.serverTime ?? Date.now()) / 60_000)
  const { data, loading, error } = useApi<CcuSeries>(`/api/series/ccu?window=${win}`, [win === '5m' || win === '15m' || win === '1h' ? minute : Math.floor(minute / 10)])

  const points = React.useMemo(() => {
    if (!data) return []
    const now = live?.serverTime ?? Date.now()
    const start = now - SPAN[win]
    const base = data.points.filter((p) => p.t >= start).map((p) => ({ t: p.t, ccu: p.ccu, official: p.official }))
    const lastT = base.length ? base[base.length - 1].t + data.bucketMs : start
    // Append real-time points received over the WebSocket after the last stored bucket.
    const fresh = ccuTrail.filter((p) => p.t >= Math.max(lastT, start)).map((p) => ({ t: p.t, ccu: p.ccu, official: null as number | null }))
    const out = [...base, ...fresh]
    if (live && (out.length || data.firstTrackedAt)) out.push({ t: now, ccu: live.ccu, official: live.official.playing })
    return out
  }, [data, ccuTrail, live, win])

  const short = win === '5m' || win === '15m' || win === '1h' || win === '6h'
  const hasOfficial = points.some((p) => p.official !== null && p.official !== undefined)
  return (
    <ChartFrame
      title={title}
      description={description}
      source="live"
      updatedAt={live?.serverTime}
      sourceNote="Stored once per minute; points after the last minute stream in live."
      loading={loading && !data}
      error={error}
      empty={!loading && (!data?.firstTrackedAt || points.length < 2)}
      emptyText="CCU history starts when the first game server reports. Install the Roblox script and join your game to begin."
      height={height}
      legend={hasOfficial ? [{ label: 'Tracked CCU (in-game)', color: HEX.primary }, { label: 'Roblox "playing" (official, polled)', color: HEX.tertiary, dashed: true }] : undefined}
      controls={
        <Tabs value={win} onValueChange={(v) => setWin(v as Win)}>
          <TabsList>
            {windows.map((w) => (
              <TabsTrigger key={w} value={w}>
                {w.toUpperCase()}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="ccuFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={HEX.primary} stopOpacity={0.75} />
              <stop offset="100%" stopColor={HEX.primary} stopOpacity={0.25} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="0" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[(live?.serverTime ?? Date.now()) - SPAN[win], live?.serverTime ?? Date.now()]}
            allowDataOverflow
            tickFormatter={(t) => (short ? clock(t, tz, win === '5m') : dateTime(t, tz).replace(/:\d\d (AM|PM)$/, ' $1'))}
            minTickGap={48}
            tickLine={false}
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={44} />
          <Tooltip content={<ChartTooltip labelFormat={(l) => dateTime(Number(l), tz)} valueFormat={(v) => num(v)} />} />
          <Area type="monotone" dataKey="ccu" name="Tracked CCU" stroke={HEX.primary} strokeWidth={2} fill="url(#ccuFill)" isAnimationActive={false} dot={false} activeDot={{ r: 4, stroke: HEX.surface, strokeWidth: 2 }} />
          {hasOfficial ? <Line type="stepAfter" dataKey="official" name='Roblox "playing"' stroke={HEX.tertiary} strokeWidth={2} strokeDasharray="4 2" dot={false} isAnimationActive={false} connectNulls /> : null}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
