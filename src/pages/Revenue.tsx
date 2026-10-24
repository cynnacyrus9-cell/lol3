import * as React from 'react'
import { CircleDollarSign, Download, Hourglass, Percent, Receipt, Ticket, UserCheck, Wallet } from 'lucide-react'
import { RangePicker, rangeQuery, type RangeValue } from '@/components/RangePicker'
import { RevenueChart } from '@/components/charts/RevenueChart'
import { ProductChart, useProducts } from '@/components/charts/ProductChart'
import { StatCard, type Comparison } from '@/components/StatCard'
import { ActivityFeed } from '@/components/ActivityFeed'
import { ProductsTable } from '@/components/ProductsTable'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useApi, useLive, useNow } from '@/state/live'
import { duration, num, pctChange, robux, shortDay } from '@/lib/format'
import { dayKey } from '@shared/time'
import type { Summary } from './types'

function cmp(cur: number | null, prev: number | null | undefined, s: Summary | null): Comparison | null {
  if (!s?.previous || !s.range.prevLabel) return null
  const has = s.previous.daysWithData > 0
  return { pct: has ? pctChange(cur, prev ?? null) : null, label: s.range.prevLabel, fallback: has ? `— vs ${s.range.prevLabel}` : `No data for ${s.range.prevLabel}` }
}

export function Revenue({ defaultRange = { preset: 'today' }, showProducts = true }: { defaultRange?: RangeValue; showProducts?: boolean } = {}) {
  const { live, config, events, revenueVersion } = useLive()
  const now = useNow(30_000)
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const [range, setRange] = React.useState<RangeValue>(defaultRange)
  const summary = useApi<Summary>(`/api/summary?${rangeQuery(range)}`, [revenueVersion])
  const products = useProducts(range)
  const s = summary.data
  const c = s?.current ?? null
  const p = s?.previous ?? null
  const net = live?.netRevenueRate ?? 0.7
  const loading = summary.loading && !s
  const avg = c && c.sales ? c.revenue / c.sales : null
  const perPlayer = c && c.uniquePlayers ? c.revenue / c.uniquePlayers : null
  const per1k = c && c.trackedVisits ? (c.revenue / c.trackedVisits) * 1000 : null
  const conversion = c && c.uniquePlayers ? c.payingPlayers / c.uniquePlayers : null
  const hours = s ? Math.max((s.range.endMs - s.range.startMs) / 3_600_000, 1 / 60) : null
  const exportUrl = (kind: string) => `/api/export.csv?kind=${kind}&${rangeQuery(range)}`

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangePicker value={range} onChange={setRange} today={dayKey(now, tz)} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" asChild>
            <a href={exportUrl('purchases')} download>
              <Download /> Purchases CSV
            </a>
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <a href={exportUrl('daily')} download>
              <Download /> Daily totals CSV
            </a>
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <a href={exportUrl('sessions')} download>
              <Download /> Sessions CSV
            </a>
          </Button>
        </div>
      </div>
      {summary.error ? <div className="rounded-lg border border-critical/30 bg-critical/5 p-3 text-sm text-[#ff9b9b]">{summary.error}</div> : null}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard accent label={`Gross Robux · ${s?.range.label ?? ''}`} icon={CircleDollarSign} value={c?.revenue ?? null} format={robux} loading={loading} source="computed" updatedAt={live?.ingest.lastPurchaseAt} comparison={cmp(c?.revenue ?? null, p?.revenue, s)} footer={hours ? `R$ ${num((c?.revenue ?? 0) / hours, 1)}/h` : undefined} />
        <StatCard label="Estimated net" icon={Wallet} value={c ? Math.floor(c.revenue * net) : null} format={robux} loading={loading} source="computed" sourceNote={`Estimate: gross × ${Math.round(net * 100)}% creator share. Roblox exposes no supported API for confirmed net or pending Robux.`} comparison={{ pct: null, label: '', fallback: 'Estimate — not confirmed by Roblox' }} />
        <StatCard label="Purchases" icon={Receipt} value={c?.sales ?? null} format={num} loading={loading} source="computed" comparison={cmp(c?.sales ?? null, p?.sales, s)} footer={c ? `${num(c.devProductSales)} products · ${num(c.gamePassSales)} passes` : undefined} />
        <StatCard label="Avg Robux / purchase" icon={Ticket} value={avg} format={(v) => (v === null ? '—' : `R$ ${num(v, 1)}`)} loading={loading} source="computed" comparison={cmp(avg, p && p.sales ? p.revenue / p.sales : null, s)} />
        <StatCard label="Developer products" icon={Receipt} value={c?.devProductRevenue ?? null} format={robux} loading={loading} source="computed" sourceNote="Exact Robux from receipt CurrencySpent." footer={c ? `${num(c.devProductSales)} sales` : undefined} />
        <StatCard label="Game passes" icon={Ticket} value={c?.gamePassRevenue ?? null} format={robux} loading={loading} source="computed" sourceNote="List price at time of verified in-experience purchase. Purchases made outside the experience are not reported by Roblox to game servers." footer={c ? `${num(c.gamePassSales)} sales` : undefined} />
        <StatCard label="Revenue per active player" icon={UserCheck} value={perPlayer} format={(v) => (v === null ? '—' : `R$ ${num(v, 2)}`)} loading={loading} source="computed" footer={per1k !== null ? `R$ ${num(per1k)} per 1,000 visits` : undefined} />
        <StatCard label="Paying-player conversion" icon={Percent} value={conversion === null ? null : conversion * 100} format={(v) => (v === null ? '—' : `${num(v, 1)}%`)} loading={loading} source="computed" sourceNote="Distinct buyers ÷ distinct players observed in-game in this range." footer={c ? `${num(c.payingPlayers)} of ${num(c.uniquePlayers)} players` : undefined} />
      </section>

      <RevenueChart range={range} height={300} />

      {showProducts ? (
      <>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <ProductChart range={range} />
        </div>
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Recent sales</CardTitle>
              <CardDescription>Verified purchases as they arrive</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="max-h-[360px] overflow-y-auto">
            <ActivityFeed events={events} tz={tz} cats={new Set(['sales'])} showTest={false} limit={40} emptyText="No sales recorded yet." />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Products</CardTitle>
            <CardDescription>Best sellers in {s?.range.label.toLowerCase() ?? 'this range'}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ProductsTable data={products.data} loading={products.loading} />
        </CardContent>
      </Card>

      </>
      ) : null}

      {s && s.daily.length > 1 ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Daily totals</CardTitle>
              <CardDescription>Stored daily aggregates ({tz}); today is live</CardDescription>
            </div>
            <Hourglass className="size-4 text-faint" aria-hidden />
          </CardHeader>
          <CardContent>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full min-w-[720px] text-[13px]">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left text-[11px] uppercase tracking-wider text-faint">
                    <th className="pb-2 font-medium">Day</th>
                    <th className="pb-2 text-right font-medium">Robux</th>
                    <th className="pb-2 text-right font-medium">Sales</th>
                    <th className="pb-2 text-right font-medium">Tracked visits</th>
                    <th className="pb-2 text-right font-medium">Official visits</th>
                    <th className="pb-2 text-right font-medium">Unique</th>
                    <th className="pb-2 text-right font-medium">Peak CCU</th>
                    <th className="pb-2 text-right font-medium">Avg CCU</th>
                    <th className="pb-2 text-right font-medium">Avg session</th>
                  </tr>
                </thead>
                <tbody>
                  {[...s.daily].reverse().map((d) => (
                    <tr key={d.day} className="border-t border-line">
                      <td className="py-2 text-ink-2">
                        {shortDay(d.day)} {d.finalized ? '' : <span className="text-[11px] text-accent">· live</span>}
                      </td>
                      <td className="tabular py-2 text-right font-medium">{robux(d.revenue)}</td>
                      <td className="tabular py-2 text-right">{num(d.sales)}</td>
                      <td className="tabular py-2 text-right">{num(d.trackedVisits)}</td>
                      <td className="tabular py-2 text-right text-ink-2">{d.officialNewVisits === null ? '—' : num(d.officialNewVisits)}</td>
                      <td className="tabular py-2 text-right">{num(d.uniquePlayers)}</td>
                      <td className="tabular py-2 text-right">{num(d.peakCcu)}</td>
                      <td className="tabular py-2 text-right text-ink-2">{num(d.avgCcu, 1)}</td>
                      <td className="tabular py-2 text-right text-ink-2">{duration(d.avgSessionSec)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
