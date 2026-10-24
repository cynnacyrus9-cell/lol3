import * as React from 'react'
import { Clock, LogIn, LogOut, Server, Timer, UserCheck, Users } from 'lucide-react'
import { CcuChart } from '@/components/charts/CcuChart'
import { VisitsChart } from '@/components/charts/VisitsChart'
import { RangePicker, type RangeValue } from '@/components/RangePicker'
import { StatCard } from '@/components/StatCard'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useLive, useNow } from '@/state/live'
import { duration, num, timeAgo } from '@/lib/format'
import { dayKey } from '@shared/time'

export function Players() {
  const { live, config } = useLive()
  const now = useNow(1000)
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const [range, setRange] = React.useState<RangeValue>({ preset: '7d' })
  const t = live?.today
  const loading = !live
  const servers = live?.servers ?? []
  return (
    <div className="space-y-5">
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard accent label="Live players" icon={Users} value={live?.ccu ?? null} format={num} loading={loading} source="live" updatedAt={live?.serverTime} footer={live?.official.playing != null ? `Roblox: ${num(live.official.playing)}` : undefined} />
        <StatCard label="Active servers" icon={Server} value={live?.activeServers ?? null} format={num} loading={loading} source="live" updatedAt={live?.ingest.lastHeartbeatAt} />
        <StatCard label="Join rate" icon={LogIn} value={live?.joinRatePerMin ?? null} format={(v) => (v === null ? '—' : `${num(v, 1)}/min`)} loading={loading} source="live" sourceNote="Joins in the last 5 minutes ÷ 5." footer={live ? `${num(live.joinsLast5m)} in, ${num(live.leavesLast5m)} out (5 min)` : undefined} />
        <StatCard label="Average session" icon={Timer} value={t?.avgSessionSec ?? null} format={duration} loading={loading} source="live" sourceNote="Sessions that ended today." footer={t ? `${num(t.sessionsEnded)} sessions ended` : undefined} />
        <StatCard label="Unique players today" icon={UserCheck} value={t?.uniquePlayers ?? null} format={num} loading={loading} source="live" />
        <StatCard label="Tracked visits today" icon={LogIn} value={t?.trackedVisits ?? null} format={num} loading={loading} source="live" />
        <StatCard label="Peak CCU today" icon={Users} value={t?.peakCcu ?? null} format={num} loading={loading} source="live" />
        <StatCard label="Average CCU today" icon={Clock} value={t?.avgCcu ?? null} format={(v) => num(v, 1)} loading={loading} source="live" sourceNote="Time-weighted since local midnight (or since tracking began today)." />
      </section>

      <CcuChart height={300} defaultWindow="1h" />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Servers</CardTitle>
            <CardDescription>Player count by server, from in-game heartbeats and join/leave events</CardDescription>
          </div>
          <LogOut className="size-4 text-faint" aria-hidden />
        </CardHeader>
        <CardContent>
          {servers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">No servers are reporting right now.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-faint">
                    <th className="pb-2 font-medium">Server (JobId)</th>
                    <th className="pb-2 text-right font-medium">Players</th>
                    <th className="pb-2 text-right font-medium">Uptime</th>
                    <th className="pb-2 text-right font-medium">Last heartbeat</th>
                    <th className="pb-2 text-right font-medium">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {servers.map((s) => {
                    const late = now - s.lastSeenAt > s.heartbeatSec * 1000 * 1.5
                    return (
                      <tr key={s.jobId} className="border-t border-line">
                        <td className="py-2 font-mono text-[12px] text-ink-2">{s.jobId}</td>
                        <td className="tabular py-2 text-right font-medium">{num(s.players)}</td>
                        <td className="tabular py-2 text-right text-ink-2">{duration((now - s.startedAt) / 1000)}</td>
                        <td className={`tabular py-2 text-right ${late ? 'text-warning' : 'text-ink-2'}`}>
                          {timeAgo(s.lastSeenAt, now)}
                          {late ? ' · late' : ''}
                        </td>
                        <td className="py-2 text-right">
                          {s.source === 'studio' ? <Badge variant="warning">Studio test</Badge> : s.source === 'synthetic' ? <Badge variant="warning">Synthetic</Badge> : s.privateServer ? <Badge>Private</Badge> : <Badge variant="outline">Public</Badge>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <VisitsChart range={range} controls={<RangePicker value={range} onChange={setRange} today={dayKey(now, tz)} />} height={280} />
    </div>
  )
}
