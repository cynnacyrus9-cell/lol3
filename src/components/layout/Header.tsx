import { CarFront, Info, LogOut, Settings, Volume2, VolumeX } from 'lucide-react'
import { useLive, useNow } from '@/state/live'
import { clock, timeAgo, tzAbbrev } from '@/lib/format'
import { ConnectionIndicator } from '@/components/ConnectionIndicator'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { apiPost } from '@/lib/api'
import { cn } from '@/lib/utils'

export type Page = 'overview' | 'feed' | 'visits' | 'spenders' | 'products' | 'hourly' | 'daily' | 'sources' | 'admin'

export const TABS: { id: Page; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'feed', label: 'Live Feed' },
  { id: 'visits', label: 'Visits' },
  { id: 'spenders', label: 'Top Spenders' },
  { id: 'products', label: 'Products' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
]

export function Header({ page, onNavigate }: { page: Page; onNavigate: (p: Page) => void }) {
  const { live, config, soundEnabled, setSoundEnabled } = useLive()
  const now = useNow(1000)
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const lastData = Math.max(live?.ingest.lastEventAt ?? 0, live?.ingest.lastHeartbeatAt ?? 0, live?.official.fetchedAt ?? 0) || null
  const iconBtn = (active: boolean) => cn('size-8 rounded-lg', active && 'bg-raised text-ink')
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-3 px-3 sm:px-5">
        <button className="flex min-w-0 items-center gap-2.5" onClick={() => onNavigate('visits')} aria-label="Go to main screen">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent/15 text-accent ring-1 ring-accent/40">
            <CarFront className="size-4" aria-hidden />
          </span>
          <h1 className="truncate text-[14px] font-extrabold uppercase tracking-[0.14em] text-ink">{config?.gameName ?? 'Roadster Life'}</h1>
        </button>
        <ConnectionIndicator compact />
        <div className="ml-auto flex items-center gap-1 sm:gap-3">
          <div className="hidden text-right md:block">
            <div className="mono text-[12px] text-ink">
              {clock(now, tz)} <span className="text-muted">{tzAbbrev(now, tz)}</span>
            </div>
            <div className="text-[10.5px] text-muted">updated {lastData ? timeAgo(lastData, now) : '—'}</div>
          </div>
          <Tip content={soundEnabled ? 'Sale sound on' : 'Sale sound off'}>
            <Button variant="ghost" size="icon" className="size-8 rounded-lg" onClick={() => setSoundEnabled(!soundEnabled)} aria-label={soundEnabled ? 'Mute sale sound' : 'Enable sale sound'}>
              {soundEnabled ? <Volume2 /> : <VolumeX />}
            </Button>
          </Tip>
          <Tip content="Data sources & connection health">
            <Button variant="ghost" size="icon" className={iconBtn(page === 'sources')} onClick={() => onNavigate('sources')} aria-label="Data sources">
              <Info />
            </Button>
          </Tip>
          <Tip content="Settings">
            <Button variant="ghost" size="icon" className={iconBtn(page === 'admin')} onClick={() => onNavigate('admin')} aria-label="Settings">
              <Settings />
            </Button>
          </Tip>
          {config?.authMode === 'password' ? (
            <Tip content="Sign out">
              <Button variant="ghost" size="icon" className="size-8 rounded-lg" onClick={() => apiPost('/auth/logout', {}).finally(() => location.reload())} aria-label="Sign out">
                <LogOut />
              </Button>
            </Tip>
          ) : null}
        </div>
      </div>
      <nav className="no-scrollbar mx-auto flex max-w-[1200px] gap-1 overflow-x-auto px-3 pb-2.5 sm:px-5" aria-label="Categories">
        {TABS.map((t) => {
          const active = t.id === page
          return (
            <button
              key={t.id}
              onClick={() => onNavigate(t.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
                active ? 'bg-accent/15 text-ink ring-1 ring-accent/40' : 'text-muted hover:bg-raised hover:text-ink',
              )}
            >
              {t.label}
            </button>
          )
        })}
      </nav>
    </header>
  )
}
