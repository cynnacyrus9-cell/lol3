import { CircleSlash, Clock3, Radio, Sigma } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/format'
import { Tip } from '@/components/ui/tooltip'
import { useNow } from '@/state/live'

export type SourceKind = 'live' | 'polled' | 'computed' | 'unavailable' | 'stale'

const META: Record<SourceKind, { label: string; icon: typeof Radio; cls: string; help: string }> = {
  live: { label: 'Live · in-game', icon: Radio, cls: 'text-[#39d239]', help: 'Pushed by your Roblox game servers the moment it happens (event-driven).' },
  polled: { label: 'Roblox API · polled', icon: Clock3, cls: 'text-accent', help: 'Fetched from the official Roblox API on a shared schedule. Roblox updates these counters with its own delay.' },
  computed: { label: 'Stored history', icon: Sigma, cls: 'text-ink-2', help: 'Computed from events stored in Cloudflare D1.' },
  unavailable: { label: 'Unavailable', icon: CircleSlash, cls: 'text-faint', help: 'No supported data source is configured or available for this value.' },
  stale: { label: 'Stale', icon: Clock3, cls: 'text-warning', help: 'The last update is older than expected; see Data sources.' },
}

export function SourceBadge({ kind, updatedAt, note, className }: { kind: SourceKind; updatedAt?: number | null; note?: string; className?: string }) {
  const now = useNow(5000)
  const m = META[kind]
  const Icon = m.icon
  return (
    <Tip content={<span>{m.help}{note ? <><br />{note}</> : null}</span>}>
      <span className={cn('inline-flex items-center gap-1 text-[11px] text-muted', className)}>
        <Icon className={cn('size-3', m.cls)} aria-hidden />
        <span>{m.label}</span>
        {updatedAt ? <span className="text-faint">· {timeAgo(updatedAt, now)}</span> : null}
      </span>
    </Tip>
  )
}
