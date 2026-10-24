import { Menu, Volume2, VolumeX } from 'lucide-react'
import { useLive, useNow } from '@/state/live'
import { clock, longDate, timeAgo, tzAbbrev } from '@/lib/format'
import { ConnectionIndicator } from '@/components/ConnectionIndicator'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'

export function Header({ onMenu }: { onMenu: () => void }) {
  const { live, config, lastMessageAt, soundEnabled, setSoundEnabled } = useLive()
  const now = useNow(1000)
  const tz = config?.timezone ?? 'America/Los_Angeles'
  // "Last successful data update": newest of any received game event, heartbeat or official poll.
  const lastData = Math.max(live?.ingest.lastEventAt ?? 0, live?.ingest.lastHeartbeatAt ?? 0, live?.official.fetchedAt ?? 0) || null
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Open navigation">
          <Menu />
        </Button>
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-[15px] font-semibold tracking-tight">{config?.gameName ?? 'Roadster Life'}</h1>
          <ConnectionIndicator />
        </div>
        <div className="ml-auto flex items-center gap-4">
          <div className="hidden text-right md:block">
            <div className="tabular text-[13px] font-medium text-ink">
              {clock(now, tz)} <span className="text-muted">{tzAbbrev(now, tz)}</span>
            </div>
            <div className="text-[11px] text-muted">{longDate(now, tz)}</div>
          </div>
          <div className="hidden border-l border-line pl-4 text-right sm:block">
            <div className="text-[11px] uppercase tracking-wider text-faint">Last data update</div>
            <div className="tabular text-[12px] text-ink-2">{lastData ? timeAgo(lastData, now) : 'waiting for data'}</div>
            {lastMessageAt ? <span className="sr-only">Last live message {timeAgo(lastMessageAt, now)}</span> : null}
          </div>
          <Tip content={soundEnabled ? 'Sale sound on' : 'Sale sound off'}>
            <Button variant="ghost" size="icon" onClick={() => setSoundEnabled(!soundEnabled)} aria-label={soundEnabled ? 'Mute sale sound' : 'Enable sale sound'}>
              {soundEnabled ? <Volume2 /> : <VolumeX />}
            </Button>
          </Tip>
        </div>
      </div>
    </header>
  )
}
