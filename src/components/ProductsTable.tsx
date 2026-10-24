import type { ProductsResponse } from '@/components/charts/types'
import { Skeleton } from '@/components/ui/skeleton'
import { num, robux, timeAgo } from '@/lib/format'
import { useNow } from '@/state/live'

export function ProductsTable({ data, loading }: { data: ProductsResponse | null; loading: boolean }) {
  const now = useNow(30_000)
  if (loading && !data) return <Skeleton className="h-32 w-full" />
  if (!data?.products.length) return <p className="py-6 text-center text-sm text-muted">No sales in this range.</p>
  const total = data.products.reduce((a, p) => a + p.revenue, 0)
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-faint">
            <th className="pb-2 font-medium">Product</th>
            <th className="pb-2 font-medium">Type</th>
            <th className="pb-2 text-right font-medium">Sales</th>
            <th className="pb-2 text-right font-medium">Buyers</th>
            <th className="pb-2 text-right font-medium">Robux</th>
            <th className="pb-2 text-right font-medium">Share</th>
            <th className="pb-2 text-right font-medium">Last sale</th>
          </tr>
        </thead>
        <tbody>
          {data.products.map((r) => (
            <tr key={`${r.kind}:${r.productId}`} className="border-t border-line">
              <td className="py-2 text-ink">
                {r.name ?? '—'} <span className="text-[11px] text-faint">#{r.productId}</span>
              </td>
              <td className="py-2 text-ink-2">{r.kind === 'game_pass' ? 'Game pass' : 'Developer product'}</td>
              <td className="mono py-2 text-right">{num(r.sales)}</td>
              <td className="mono py-2 text-right text-ink-2">{num(r.buyers)}</td>
              <td className="mono py-2 text-right font-semibold">{robux(r.revenue)}</td>
              <td className="mono py-2 text-right text-ink-2">{total ? `${((r.revenue / total) * 100).toFixed(1)}%` : '—'}</td>
              <td className="py-2 text-right text-muted">{timeAgo(r.lastSoldAt, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
