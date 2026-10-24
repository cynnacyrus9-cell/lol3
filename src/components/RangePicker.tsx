import * as React from 'react'
import type { RangePreset } from '@shared/time'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'

export interface RangeValue {
  preset: RangePreset
  from?: string
  to?: string
}

export function rangeQuery(r: RangeValue): string {
  const q = new URLSearchParams({ range: r.preset })
  if (r.preset === 'custom' && r.from && r.to) {
    q.set('from', r.from)
    q.set('to', r.to)
  }
  return q.toString()
}

const OPTIONS: { id: RangePreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: 'month', label: 'Month' },
  { id: 'all', label: 'All' },
  { id: 'custom', label: 'Custom' },
]

export function RangePicker({ value, onChange, today }: { value: RangeValue; onChange: (v: RangeValue) => void; today: string }) {
  const [from, setFrom] = React.useState(value.from ?? today)
  const [to, setTo] = React.useState(value.to ?? today)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs value={value.preset} onValueChange={(p) => onChange(p === 'custom' ? { preset: 'custom', from, to } : { preset: p as RangePreset })}>
        <TabsList>
          {OPTIONS.map((o) => (
            <TabsTrigger key={o.id} value={o.id}>
              {o.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {value.preset === 'custom' ? (
        <div className="flex items-center gap-1.5">
          <Input type="date" aria-label="From date" className="h-8 w-[9.5rem] text-xs" value={from} max={to} onChange={(e) => setFrom(e.target.value)} onBlur={() => onChange({ preset: 'custom', from, to })} />
          <span className="text-xs text-muted">→</span>
          <Input type="date" aria-label="To date" className="h-8 w-[9.5rem] text-xs" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} onBlur={() => onChange({ preset: 'custom', from, to })} />
        </div>
      ) : null}
    </div>
  )
}
