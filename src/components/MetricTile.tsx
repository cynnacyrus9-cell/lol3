import * as React from 'react'
import { AnimatedNumber } from '@/components/AnimatedNumber'
import { Skeleton } from '@/components/ui/skeleton'
import { Tip } from '@/components/ui/tooltip'
import type { SourceKind } from '@/components/SourceBadge'
import { timeAgo } from '@/lib/format'
import { useNow } from '@/state/live'
import { cn } from '@/lib/utils'

const DOT: Record<SourceKind, { cls: string; label: string }> = {
  live: { cls: 'bg-good live-dot', label: 'Live from your game servers' },
  polled: { cls: 'bg-accent', label: 'Official Roblox data, polled on a shared schedule' },
  computed: { cls: 'bg-ink-2', label: 'Computed from stored history' },
  unavailable: { cls: 'bg-faint', label: 'Unavailable' },
  stale: { cls: 'bg-warning', label: 'Stale — last update is older than expected' },
}

export function SourceDot({ kind, updatedAt, note }: { kind: SourceKind; updatedAt?: number | null; note?: string }) {
  const now = useNow(5000)
  const d = DOT[kind]
  return (
    <Tip
      content={
        <span>
          {d.label}
          {updatedAt ? ` · updated ${timeAgo(updatedAt, now)}` : ''}
          {note ? (
            <>
              <br />
              {note}
            </>
          ) : null}
        </span>
      }
    >
      <span className="inline-flex size-4 items-center justify-center" aria-label={d.label} role="img">
        <span className={cn('inline-block size-1.5 rounded-full', d.cls)} />
      </span>
    </Tip>
  )
}

/** Compact tile in the style of the main screen: caps label, big mono value, caption. */
export function MetricTile({
  label,
  value,
  format,
  caption,
  source,
  updatedAt,
  note,
  loading,
}: {
  label: string
  value: number | null
  format: (v: number | null) => string
  caption: React.ReactNode
  source: SourceKind
  updatedAt?: number | null
  note?: string
  loading?: boolean
}) {
  const [flash, setFlash] = React.useState(0)
  const prev = React.useRef(value)
  React.useEffect(() => {
    if (prev.current !== null && value !== null && value > prev.current) setFlash((f) => f + 1)
    prev.current = value
  }, [value])
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="label-caps truncate text-muted">{label}</span>
        <SourceDot kind={source} updatedAt={updatedAt} note={note} />
      </div>
      <div key={flash} className={cn('mono mt-1 text-[24px] font-bold leading-tight text-ink sm:text-[28px]', flash > 0 && 'tick-up')}>
        {loading ? <Skeleton className="my-1 h-7 w-24" /> : <AnimatedNumber value={value} format={format} />}
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted">{caption}</div>
    </div>
  )
}
