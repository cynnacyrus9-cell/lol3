import * as React from 'react'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartFrame, ChartTooltip, HEX } from './common'
import type { ProductsResponse } from './types'
import { rangeQuery, type RangeValue } from '@/components/RangePicker'
import { useApi, useLive } from '@/state/live'
import { num } from '@/lib/format'

export function useProducts(range: RangeValue) {
  const { revenueVersion } = useLive()
  return useApi<ProductsResponse>(`/api/products?${rangeQuery(range)}`, [revenueVersion])
}

export function ProductChart({ range, controls, height = 280 }: { range: RangeValue; controls?: React.ReactNode; height?: number }) {
  const { live } = useLive()
  const { data, loading, error } = useProducts(range)
  const rows = React.useMemo(
    () => (data?.products ?? []).slice(0, 12).map((p) => ({ ...p, label: p.name ?? `${p.kind === 'game_pass' ? 'Pass' : 'Product'} ${p.productId}` })),
    [data],
  )
  return (
    <ChartFrame
      title="Sales by product"
      description="Gross Robux by developer product and game pass"
      source="live"
      updatedAt={live?.ingest.lastPurchaseAt}
      loading={loading && !data}
      error={error}
      empty={!loading && rows.length === 0}
      emptyText="No verified sales in this period."
      height={Math.max(height, rows.length * 30 + 40)}
      controls={controls}
      legend={[
        { label: 'Developer product', color: HEX.primary },
        { label: 'Game pass', color: HEX.secondary },
      ]}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 8 }} barCategoryGap={6}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v) => num(v)} />
          <YAxis type="category" dataKey="label" width={130} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
            content={(p) => {
              const row = (p as unknown as { payload?: readonly { payload?: (typeof rows)[number] }[] }).payload?.[0]?.payload
              return (
                <ChartTooltip
                  {...(p as object)}
                  labelFormat={(l) => `${l}${row ? ` · ${num(row.sales)} sales · ${num(row.buyers)} buyers` : ''}`}
                  valueFormat={(v) => `R$ ${num(v)}`}
                />
              )
            }}
          />
          <Bar dataKey="revenue" name="Revenue" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {rows.map((r) => (
              <Cell key={`${r.kind}:${r.productId}`} fill={r.kind === 'game_pass' ? HEX.secondary : HEX.primary} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}
