import { Award, CircleDollarSign, Target, TrendingUp, X } from 'lucide-react'
import { useLive } from '@/state/live'
import { clock, num } from '@/lib/format'
import { Badge } from '@/components/ui/badge'

export function SaleToasts() {
  const { toasts, dismissToast, config } = useLive()
  const tz = config?.timezone ?? 'America/Los_Angeles'
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(340px,calc(100vw-2rem))] flex-col gap-2" aria-live="assertive">
      {toasts.map((t) => {
        if (t.kind === 'sale' && t.sale) {
          const s = t.sale
          return (
            <div key={t.id} className="toast-in pointer-events-auto overflow-hidden rounded-xl border border-good/30 bg-[#0f2620]/95 shadow-2xl shadow-black/60 backdrop-blur">
              <div className="h-0.5 bg-gradient-to-r from-good/0 via-good to-good/0" />
              <div className="flex items-start gap-3 p-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-good/15 text-[#4ee39a]">
                  <CircleDollarSign className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-bold tracking-[0.12em] text-[#4ee39a]">NEW SALE — {num(s.robux)} ROBUX</div>
                  <div className="mt-0.5 truncate text-sm font-semibold text-ink">{s.productName ?? `Product ${s.productId}`}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <Badge variant="outline">{s.kind === 'game_pass' ? 'Game pass' : 'Developer product'}</Badge>
                    <span className="tabular">{clock(s.purchasedAt, tz)}</span>
                    {s.username ? <span>· {s.username}</span> : null}
                    {s.source === 'synthetic' ? <Badge variant="warning">Synthetic</Badge> : null}
                  </div>
                </div>
                <button className="rounded p-1 text-muted hover:bg-raised hover:text-ink" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          )
        }
        const e = t.event!
        const Icon = t.kind === 'milestone' ? Award : t.kind === 'goal' ? Target : TrendingUp
        const text =
          t.kind === 'milestone'
            ? `Revenue milestone: R$ ${num(Number(e.data.amount))} all-time`
            : t.kind === 'goal'
              ? `Daily goal reached: R$ ${num(Number(e.data.goal))}`
              : `New all-time CCU peak: ${num(Number(e.data.ccu))}`
        return (
          <div key={t.id} className="toast-in pointer-events-auto flex items-center gap-3 rounded-xl border border-warning/30 bg-[#221f12]/95 p-3.5 shadow-2xl shadow-black/60 backdrop-blur">
            <Icon className="size-5 text-warning" aria-hidden />
            <div className="flex-1 text-sm font-medium text-ink">{text}</div>
            <button className="rounded p-1 text-muted hover:bg-raised hover:text-ink" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
