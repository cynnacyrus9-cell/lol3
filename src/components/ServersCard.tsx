import { Server } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useLive, useNow } from '@/state/live'
import { duration, num, timeAgo } from '@/lib/format'

export function ServersCard() {
  const { live } = useLive()
  const now = useNow(1000)
  const servers = live?.servers ?? []
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Servers</CardTitle>
          <CardDescription>Player count by server, from in-game heartbeats and join/leave events</CardDescription>
        </div>
        <Server className="size-4 text-faint" aria-hidden />
      </CardHeader>
      <CardContent>
        {servers.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No servers are reporting right now.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-faint">
                  <th className="pb-2 font-medium">Server (JobId)</th>
                  <th className="pb-2 text-right font-medium">Players</th>
                  <th className="pb-2 text-right font-medium">Uptime</th>
                  <th className="pb-2 text-right font-medium">Heartbeat</th>
                  <th className="pb-2 text-right font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => {
                  const late = now - s.lastSeenAt > s.heartbeatSec * 1000 * 1.5
                  return (
                    <tr key={s.jobId} className="border-t border-line">
                      <td className="mono py-2 text-[12px] text-ink-2">{s.jobId.slice(0, 18)}</td>
                      <td className="mono py-2 text-right font-semibold">{num(s.players)}</td>
                      <td className="mono py-2 text-right text-ink-2">{duration((now - s.startedAt) / 1000)}</td>
                      <td className={`py-2 text-right ${late ? 'text-warning' : 'text-ink-2'}`}>
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
  )
}
