import * as React from 'react'
import { Award, CircleDollarSign, LogIn, LogOut, Server, ServerOff, Target, TrendingUp } from 'lucide-react'
import type { ActivityCategory, ActivityEvent } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { clock, dateTime, duration, num } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useNow } from '@/state/live'

const ICONS: Record<ActivityEvent['type'], { icon: typeof LogIn; cls: string }> = {
  player_join: { icon: LogIn, cls: 'text-accent bg-accent-soft' },
  player_leave: { icon: LogOut, cls: 'text-muted bg-raised' },
  purchase: { icon: CircleDollarSign, cls: 'text-[#4ee39a] bg-good/10' },
  ccu_peak: { icon: TrendingUp, cls: 'text-warning bg-warning/10' },
  server_open: { icon: Server, cls: 'text-ink-2 bg-raised' },
  server_close: { icon: ServerOff, cls: 'text-serious bg-serious/10' },
  milestone: { icon: Award, cls: 'text-warning bg-warning/10' },
  goal_reached: { icon: Target, cls: 'text-[#4ee39a] bg-good/10' },
}

function who(d: Record<string, unknown>): string {
  return typeof d.username === 'string' && d.username ? d.username : d.userId ? `Player ${d.userId}` : 'A player'
}

function shortJob(id: unknown): string {
  return typeof id === 'string' ? id.slice(0, 8) : '—'
}

export function describe(e: ActivityEvent): { title: React.ReactNode; detail?: string } {
  const d = e.data
  switch (e.type) {
    case 'player_join':
      return { title: <><b className="font-semibold text-ink">{who(d)}</b> joined</>, detail: `server ${shortJob(d.jobId)}${d.reconciled ? ' · join recovered from heartbeat' : ''}` }
    case 'player_leave': {
      const reason = d.reason === 'server_timeout' ? ' · server stopped responding' : d.reason === 'server_shutdown' ? ' · server shut down' : ''
      return { title: <><b className="font-semibold text-ink">{who(d)}</b> left</>, detail: `session ${duration(Number(d.sessionSec))}${reason}` }
    }
    case 'purchase':
      return {
        title: (
          <>
            <b className="font-semibold text-[#4ee39a]">R$ {num(Number(d.robux))}</b> · {String(d.productName ?? `Product ${d.productId}`)}
          </>
        ),
        detail: `${d.kind === 'game_pass' ? 'Game pass (list price)' : 'Developer product'}${d.username ? ` · ${d.username}` : ''}`,
      }
    case 'ccu_peak':
      return { title: <>New {d.scope === 'all_time' ? 'all-time' : "today's"} CCU peak: <b className="font-semibold text-ink">{num(Number(d.ccu))}</b></> }
    case 'server_open':
      return { title: <>Server opened</>, detail: `${shortJob(d.jobId)}${d.privateServer ? ' · private server' : ''}` }
    case 'server_close':
      return {
        title: <>Server closed{d.reason === 'heartbeat_timeout' ? ' (missed heartbeats)' : ''}</>,
        detail: `${shortJob(d.jobId)} · uptime ${duration(Number(d.uptimeSec))} · peak ${num(Number(d.peakPlayers))} players`,
      }
    case 'milestone':
      return { title: <>Revenue milestone: <b className="font-semibold text-ink">R$ {num(Number(d.amount))}</b> all-time</> }
    case 'goal_reached':
      return { title: <>Daily goal reached: <b className="font-semibold text-ink">R$ {num(Number(d.goal))}</b></>, detail: `R$ ${num(Number(d.revenue))} today` }
  }
}

const CATS: { id: ActivityCategory; label: string }[] = [
  { id: 'sales', label: 'Sales' },
  { id: 'players', label: 'Players' },
  { id: 'servers', label: 'Servers' },
  { id: 'milestones', label: 'Milestones' },
]

export function useFeedFilter(initial: ActivityCategory[] = ['sales', 'players', 'servers', 'milestones']) {
  const [cats, setCats] = React.useState<Set<ActivityCategory>>(new Set(initial))
  const toggle = (c: ActivityCategory) =>
    setCats((cur) => {
      const n = new Set(cur)
      if (n.has(c)) n.delete(c)
      else n.add(c)
      return n.size ? n : new Set(initial)
    })
  return { cats, toggle }
}

export function FeedFilters({ cats, toggle }: { cats: Set<ActivityCategory>; toggle: (c: ActivityCategory) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter events">
      {CATS.map((c) => (
        <button
          key={c.id}
          onClick={() => toggle(c.id)}
          aria-pressed={cats.has(c.id)}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
            cats.has(c.id) ? 'border-accent/40 bg-accent-soft text-ink' : 'border-line-strong text-muted hover:text-ink-2',
          )}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}

export function ActivityFeed({
  events,
  tz,
  cats,
  showTest,
  limit = 60,
  className,
  emptyText = 'No activity yet. Events appear here the moment your game servers report them.',
}: {
  events: ActivityEvent[]
  tz: string
  cats: Set<ActivityCategory>
  showTest: boolean
  limit?: number
  className?: string
  emptyText?: string
}) {
  const now = useNow(30_000)
  const seen = React.useRef<Set<number>>(new Set())
  const [mountedAt] = React.useState(() => Date.now())
  const list = events.filter((e) => cats.has(e.category) && (showTest || e.source === 'live' || e.source === 'synthetic')).slice(0, limit)
  if (!list.length) return <p className="py-10 text-center text-sm text-muted">{emptyText}</p>
  return (
    <ol className={cn('divide-y divide-line', className)} aria-live="polite" aria-relevant="additions">
      {list.map((e) => {
        const meta = ICONS[e.type]
        const Icon = meta.icon
        const { title, detail } = describe(e)
        const fresh = !seen.current.has(e.seq) && Date.now() - mountedAt > 1500
        seen.current.add(e.seq)
        return (
          <li key={e.seq} className={cn('flex items-start gap-3 px-1 py-2.5', fresh && 'feed-in')}>
            <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg', meta.cls)}>
              <Icon className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-ink-2">{title}</div>
              {detail ? <div className="truncate text-[11px] text-faint">{detail}</div> : null}
            </div>
            <div className="shrink-0 text-right">
              <time className="tabular block text-[11px] text-muted" dateTime={new Date(e.at).toISOString()} title={dateTime(e.at, tz)}>
                {now - e.at < 86_400_000 ? clock(e.at, tz) : dateTime(e.at, tz)}
              </time>
              {e.source !== 'live' ? (
                <Badge variant="warning" className="mt-0.5">
                  {e.source === 'studio' ? 'Studio test' : 'Synthetic'}
                </Badge>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
