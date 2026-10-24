import * as React from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { AnimatedNumber } from '@/components/AnimatedNumber'
import { SourceBadge, type SourceKind } from '@/components/SourceBadge'
import { cn } from '@/lib/utils'

export interface Comparison {
  pct: number | null
  label: string
  /** Text used when pct cannot be computed (e.g. no previous data). */
  fallback?: string
  invert?: boolean
}

export function Delta({ c }: { c: Comparison | null }) {
  if (!c) return null
  if (c.pct === null) return <span className="text-[11px] text-faint">{c.fallback ?? `No data for ${c.label}`}</span>
  const up = c.pct > 0.0005
  const down = c.pct < -0.0005
  const good = c.invert ? down : up
  const bad = c.invert ? up : down
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium', good && 'text-[#39d239]', bad && 'text-[#ff7b7b]', !good && !bad && 'text-muted')}>
      <Icon className="size-3.5" aria-hidden />
      <span className="tabular">{`${up ? '+' : ''}${(c.pct * 100).toFixed(Math.abs(c.pct) < 0.1 ? 1 : 0)}%`}</span>
      <span className="font-normal text-faint">vs {c.label}</span>
    </span>
  )
}

export function StatCard({
  label,
  value,
  format,
  icon: Icon,
  source,
  updatedAt,
  sourceNote,
  comparison,
  footer,
  loading,
  accent,
}: {
  label: string
  value: number | null
  format: (v: number | null) => string
  icon: LucideIcon
  source: SourceKind
  updatedAt?: number | null
  sourceNote?: string
  comparison?: Comparison | null
  footer?: React.ReactNode
  loading?: boolean
  accent?: boolean
}) {
  const [flash, setFlash] = React.useState(0)
  const prev = React.useRef(value)
  React.useEffect(() => {
    if (prev.current !== null && value !== null && value !== prev.current) setFlash((f) => f + 1)
    prev.current = value
  }, [value])
  return (
    <Card className={cn('relative overflow-hidden p-4 sm:p-5', accent && 'border-accent/25')}>
      {flash > 0 ? <div key={flash} aria-hidden className="flash pointer-events-none absolute inset-0 rounded-[var(--radius-card)]" /> : null}
      {accent ? <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" /> : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</span>
        <Icon className="size-4 text-faint" aria-hidden />
      </div>
      <div className="mt-2.5 min-h-[40px] text-[28px] font-semibold leading-tight tracking-tight text-ink sm:text-[32px]">
        {loading ? <Skeleton className="h-9 w-32" /> : <AnimatedNumber value={value} format={format} />}
      </div>
      <div className="mt-2 flex min-h-[18px] flex-wrap items-center gap-x-3 gap-y-1">{loading ? <Skeleton className="h-3 w-24" /> : <Delta c={comparison ?? null} />}</div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5">
        <SourceBadge kind={source} updatedAt={updatedAt} note={sourceNote} />
        {footer ? <span className="text-[11px] text-muted">{footer}</span> : null}
      </div>
    </Card>
  )
}
