import { Activity, BarChart3, Database, Gauge, LogOut, Settings, Users, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLive } from '@/state/live'
import { apiPost } from '@/lib/api'

export type Page = 'overview' | 'players' | 'revenue' | 'activity' | 'sources' | 'admin'

const NAV: { id: Page; label: string; icon: typeof Gauge }[] = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'players', label: 'Players', icon: Users },
  { id: 'revenue', label: 'Revenue', icon: BarChart3 },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'sources', label: 'Data sources', icon: Database },
  { id: 'admin', label: 'Admin', icon: Settings },
]

export function Sidebar({ page, onNavigate, open, onClose }: { page: Page; onNavigate: (p: Page) => void; open: boolean; onClose: () => void }) {
  const { config, live } = useLive()
  return (
    <>
      <div className={cn('fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden', open ? 'block' : 'hidden')} onClick={onClose} aria-hidden />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-line bg-panel transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <img src="/favicon.svg" alt="" className="size-7 rounded-md" />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold">Roadster Life</div>
            <div className="text-[11px] text-muted">Analytics</div>
          </div>
          <button className="ml-auto rounded-md p-1 text-muted hover:bg-raised lg:hidden" onClick={onClose} aria-label="Close navigation">
            <X className="size-4" />
          </button>
        </div>
        <nav className="flex-1 space-y-0.5 p-2.5" aria-label="Main">
          {NAV.map((n) => {
            const Icon = n.icon
            const active = n.id === page
            return (
              <button
                key={n.id}
                onClick={() => {
                  onNavigate(n.id)
                  onClose()
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors',
                  active ? 'bg-accent-soft text-ink shadow-[inset_2px_0_0_var(--color-accent)]' : 'text-ink-2 hover:bg-raised hover:text-ink',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <Icon className={cn('size-4', active ? 'text-accent' : 'text-muted')} aria-hidden />
                {n.label}
              </button>
            )
          })}
        </nav>
        <div className="space-y-2 border-t border-line p-3 text-[11px] text-muted">
          {live?.mode === 'development' ? <div className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 font-semibold text-warning">DEVELOPMENT MODE</div> : null}
          <div>
            Reporting timezone
            <div className="text-ink-2">{config?.timezone ?? '—'}</div>
          </div>
          {config?.authMode === 'password' ? (
            <button
              className="inline-flex items-center gap-1.5 text-muted hover:text-ink"
              onClick={() => apiPost('/auth/logout', {}).finally(() => location.reload())}
            >
              <LogOut className="size-3.5" /> Sign out
            </button>
          ) : null}
        </div>
      </aside>
    </>
  )
}
