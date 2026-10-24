import * as React from 'react'
import { BarChart2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { SourceBadge, type SourceKind } from '@/components/SourceBadge'

export const SERIES = {
  primary: 'var(--color-series-1)',
  secondary: 'var(--color-series-2)',
  tertiary: 'var(--color-series-3)',
}
// Recharts needs concrete colors for some SVG attributes.
export const HEX = { primary: '#25a58e', secondary: '#d96c33', tertiary: '#5b8def', surface: '#172a31', grid: '#223b44', axis: '#84a2a7' }

export function ChartFrame({
  title,
  description,
  source,
  sourceNote,
  updatedAt,
  controls,
  loading,
  error,
  empty,
  emptyText,
  height = 260,
  legend,
  children,
}: {
  title: string
  description?: string
  source: SourceKind
  sourceNote?: string
  updatedAt?: number | null
  controls?: React.ReactNode
  loading?: boolean
  error?: string | null
  empty?: boolean
  emptyText?: string
  height?: number
  legend?: { label: string; color: string; dashed?: boolean }[]
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {controls}
      </CardHeader>
      <CardContent>
        {legend && legend.length > 1 ? (
          <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2" aria-label="Legend">
            {legend.map((l) => (
              <li key={l.label} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-2 w-3 rounded-sm"
                  style={l.dashed ? { background: `repeating-linear-gradient(90deg, ${l.color} 0 4px, transparent 4px 6px)`, height: 2 } : { background: l.color }}
                />
                {l.label}
              </li>
            ))}
          </ul>
        ) : null}
        <div style={{ height }} className="relative">
          {loading ? (
            <Skeleton className="h-full w-full" />
          ) : error ? (
            <div className="grid h-full place-items-center rounded-lg border border-critical/30 bg-critical/5 p-4 text-center text-sm text-[#ff9b9b]">Could not load this chart: {error}</div>
          ) : empty ? (
            <div className="grid h-full place-items-center rounded-lg border border-dashed border-line-strong p-4 text-center">
              <div>
                <BarChart2 className="mx-auto mb-2 size-5 text-faint" aria-hidden />
                <p className="text-sm text-ink-2">Not enough data yet</p>
                <p className="mt-1 max-w-sm text-xs text-muted">{emptyText ?? 'History appears here once it has been collected. Nothing is back-filled or simulated.'}</p>
              </div>
            </div>
          ) : (
            children
          )}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <SourceBadge kind={source} updatedAt={updatedAt} note={sourceNote} />
        </div>
      </CardContent>
    </Card>
  )
}

export function ChartTooltip({
  active,
  payload,
  label,
  labelFormat,
  valueFormat,
}: {
  active?: boolean
  payload?: { name?: string; value?: number | null; color?: string; dataKey?: string; payload?: Record<string, unknown> }[]
  label?: number | string
  labelFormat: (l: number | string) => string
  valueFormat?: (v: number | null | undefined, key?: string) => string
}) {
  if (!active || !payload?.length || label === undefined) return null
  return (
    <div className="rounded-lg border border-line-strong bg-[#12232a]/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      <div className="mb-1 font-medium text-ink">{labelFormat(label)}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 text-ink-2">
            <span aria-hidden className="inline-block size-2 rounded-sm" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="tabular font-medium text-ink">{valueFormat ? valueFormat(p.value, String(p.dataKey)) : p.value ?? '—'}</span>
        </div>
      ))}
    </div>
  )
}
