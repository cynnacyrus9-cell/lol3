import * as React from 'react'
import { ProductChart, useProducts } from '@/components/charts/ProductChart'
import { ProductsTable } from '@/components/ProductsTable'
import { RangePicker, type RangeValue } from '@/components/RangePicker'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useLive, useNow } from '@/state/live'
import { dayKey } from '@shared/time'

export function Products() {
  const { config } = useLive()
  const now = useNow(60_000)
  const [range, setRange] = React.useState<RangeValue>({ preset: '30d' })
  const products = useProducts(range)
  return (
    <div className="space-y-3">
      <RangePicker value={range} onChange={setRange} today={dayKey(now, config?.timezone ?? 'America/Los_Angeles')} />
      <ProductChart range={range} />
      <Card>
        <CardHeader>
          <div>
            <CardTitle>All products</CardTitle>
            <CardDescription>Developer products use the exact receipt amount; game passes use the list price at purchase.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ProductsTable data={products.data} loading={products.loading} />
        </CardContent>
      </Card>
    </div>
  )
}
