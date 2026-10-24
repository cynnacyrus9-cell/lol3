import { Wifi, WifiOff, RefreshCw, Radio } from 'lucide-react'
import { useLive, useNow } from '@/state/live'
import { cn } from '@/lib/utils'
import { Tip } from '@/components/ui/tooltip'

export function ConnectionIndicator({ compact = false }: { compact?: boolean }) {
  const { connection } = useLive()
  const now = useNow(1000)
  const s = connection.state
  const retryIn = connection.nextRetryAt ? Math.max(0, Math.ceil((connection.nextRetryAt - now) / 1000)) : null
  const meta =
    s === 'live'
      ? { label: 'LIVE', cls: 'border-good/40 bg-good/10 text-[#39d239]', icon: Radio, help: 'Connected over WebSocket. Updates arrive as soon as the backend receives them.' }
      : s === 'fallback'
        ? { label: 'LIVE (SSE)', cls: 'border-warning/40 bg-warning/10 text-warning', icon: Wifi, help: 'WebSockets are blocked on this network; using Server-Sent Events instead.' }
        : s === 'connecting'
          ? { label: 'CONNECTING', cls: 'border-line-strong bg-raised text-ink-2', icon: RefreshCw, help: 'Opening the live connection…' }
          : s === 'reconnecting'
            ? { label: retryIn !== null ? `RECONNECTING ${retryIn}s` : 'RECONNECTING', cls: 'border-warning/40 bg-warning/10 text-warning', icon: RefreshCw, help: 'Connection lost. Missed events will be replayed when it reconnects.' }
            : { label: 'OFFLINE', cls: 'border-critical/40 bg-critical/10 text-[#ff7b7b]', icon: WifiOff, help: 'Not connected.' }
  const Icon = meta.icon
  return (
    <Tip content={meta.help}>
      <span className={cn('inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-bold tracking-wider', meta.cls)} role="status" aria-live="polite">
        {s === 'live' ? <span className="live-dot inline-block size-2 rounded-full bg-good" aria-hidden /> : <Icon className={cn('size-3.5', s !== 'offline' && 'animate-spin [animation-duration:2s]')} aria-hidden />}
        {compact && s === 'live' ? 'LIVE' : meta.label}
      </span>
    </Tip>
  )
}
