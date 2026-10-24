import * as React from 'react'
import type { ActivityEvent, LiveSnapshot, PublicConfig, SaleEvent, ServerMessage } from '@shared/types'
import { apiFetch } from '@/lib/api'
import { LiveClient, type ConnectionState } from '@/lib/live-client'
import { playSaleSound, readPref, writePref } from '@/lib/sound'

export interface Toast {
  id: string
  kind: 'sale' | 'milestone' | 'goal' | 'peak'
  at: number
  sale?: SaleEvent
  event?: ActivityEvent
}

interface LiveContextValue {
  config: PublicConfig | null
  setConfig: (c: PublicConfig) => void
  live: LiveSnapshot | null
  events: ActivityEvent[]
  connection: { state: ConnectionState; attempts: number; nextRetryAt: number | null; transport: 'ws' | 'sse' | null }
  lastMessageAt: number | null
  ccuTrail: { t: number; ccu: number }[]
  revenueVersion: number
  toasts: Toast[]
  dismissToast: (id: string) => void
  soundEnabled: boolean
  setSoundEnabled: (v: boolean) => void
  showTestEvents: boolean
  setShowTestEvents: (v: boolean) => void
  bootError: string | null
  reload: () => void
}

const LiveContext = React.createContext<LiveContextValue | null>(null)

export function useLive(): LiveContextValue {
  const v = React.useContext(LiveContext)
  if (!v) throw new Error('useLive must be used inside <LiveProvider>')
  return v
}

const MAX_EVENTS = 400
const TRAIL_MS = 7 * 24 * 3_600_000

function mergeEvents(existing: ActivityEvent[], incoming: ActivityEvent[]): ActivityEvent[] {
  if (!incoming.length) return existing
  const bySeq = new Map(existing.map((e) => [e.seq, e]))
  for (const e of incoming) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, MAX_EVENTS)
}

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = React.useState<PublicConfig | null>(null)
  const [live, setLive] = React.useState<LiveSnapshot | null>(null)
  const [events, setEvents] = React.useState<ActivityEvent[]>([])
  const [connection, setConnection] = React.useState<LiveContextValue['connection']>({ state: 'connecting', attempts: 0, nextRetryAt: null, transport: null })
  const [lastMessageAt, setLastMessageAt] = React.useState<number | null>(null)
  const [ccuTrail, setCcuTrail] = React.useState<{ t: number; ccu: number }[]>([])
  const [revenueVersion, setRevenueVersion] = React.useState(0)
  const [toasts, setToasts] = React.useState<Toast[]>([])
  const [soundEnabled, setSound] = React.useState(() => readPref('rl.sound', false))
  const [showTestEvents, setShowTest] = React.useState(() => readPref('rl.showTest', false))
  const [bootError, setBootError] = React.useState<string | null>(null)
  const [bootKey, setBootKey] = React.useState(0)
  const soundRef = React.useRef(soundEnabled)
  soundRef.current = soundEnabled

  const pushToast = React.useCallback((t: Toast) => {
    setToasts((cur) => [t, ...cur.filter((x) => x.id !== t.id)].slice(0, 3))
    window.setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== t.id)), t.kind === 'sale' ? 9000 : 12000)
  }, [])

  const applyLive = React.useCallback((snap: LiveSnapshot) => {
    setLive(snap)
    setCcuTrail((cur) => {
      const last = cur[cur.length - 1]
      if (last && last.ccu === snap.ccu && snap.serverTime - last.t < 60_000) return cur
      const cutoff = snap.serverTime - TRAIL_MS
      return [...cur.filter((p) => p.t >= cutoff), { t: snap.serverTime, ccu: snap.ccu }].slice(-5000)
    })
  }, [])

  const onMessage = React.useCallback(
    (msg: ServerMessage) => {
      setLastMessageAt(Date.now())
      switch (msg.t) {
        case 'hello':
          applyLive(msg.live)
          if (msg.gap) {
            apiFetch<{ events: ActivityEvent[] }>('/api/activity?limit=100&includeTest=1')
              .then((r) => setEvents((cur) => mergeEvents(cur, r.events)))
              .catch(() => {})
            setRevenueVersion((v) => v + 1)
          } else if (msg.missed.length) {
            setEvents((cur) => mergeEvents(cur, msg.missed))
            if (msg.missed.some((e) => e.type === 'purchase')) setRevenueVersion((v) => v + 1)
          }
          break
        case 'live':
          applyLive(msg.live)
          break
        case 'event': {
          const e = msg.event
          setEvents((cur) => mergeEvents(cur, [e]))
          if (e.source !== 'live' && e.source !== 'synthetic') break
          if (e.type === 'milestone' || e.type === 'goal_reached') pushToast({ id: `ev-${e.seq}`, kind: e.type === 'milestone' ? 'milestone' : 'goal', at: Date.now(), event: e })
          if (e.type === 'ccu_peak' && e.data.scope === 'all_time') pushToast({ id: `ev-${e.seq}`, kind: 'peak', at: Date.now(), event: e })
          break
        }
        case 'sale': {
          setRevenueVersion((v) => v + 1)
          const counted = msg.sale.source === 'live' || msg.sale.source === 'synthetic'
          if (counted) {
            pushToast({ id: `sale-${msg.sale.dedupeKey}`, kind: 'sale', at: Date.now(), sale: msg.sale })
            if (soundRef.current) playSaleSound()
          }
          break
        }
      }
    },
    [applyLive, pushToast],
  )

  React.useEffect(() => {
    let client: LiveClient | null = null
    let cancelled = false
    setBootError(null)
    apiFetch<{ config: PublicConfig; live: LiveSnapshot; recent: ActivityEvent[] }>('/api/bootstrap')
      .then((boot) => {
        if (cancelled) return
        setConfig(boot.config)
        applyLive(boot.live)
        setEvents((cur) => mergeEvents(cur, boot.recent))
        setLastMessageAt(Date.now())
        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        client = new LiveClient({
          wsUrl: `${proto}://${location.host}/api/live`,
          sseUrl: `/api/stream`,
          onMessage,
          onState: (state, info) => setConnection({ state, ...info }),
          EventSourceImpl: typeof EventSource !== 'undefined' ? EventSource : undefined,
        })
        client.setSeq(boot.live.seq)
        client.start()
      })
      .catch((err: Error) => !cancelled && setBootError(err.message))
    const online = () => client?.kick()
    const visible = () => document.visibilityState === 'visible' && client?.kick()
    window.addEventListener('online', online)
    document.addEventListener('visibilitychange', visible)
    return () => {
      cancelled = true
      client?.stop()
      window.removeEventListener('online', online)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [applyLive, onMessage, bootKey])

  const value: LiveContextValue = {
    config,
    setConfig,
    live,
    events,
    connection,
    lastMessageAt,
    ccuTrail,
    revenueVersion,
    toasts,
    dismissToast: (id) => setToasts((cur) => cur.filter((t) => t.id !== id)),
    soundEnabled,
    setSoundEnabled: (v) => {
      setSound(v)
      writePref('rl.sound', v)
      if (v) playSaleSound()
    },
    showTestEvents,
    setShowTestEvents: (v) => {
      setShowTest(v)
      writePref('rl.showTest', v)
    },
    bootError,
    reload: () => setBootKey((k) => k + 1),
  }
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

/** Ticks every `ms` so relative times ("3s ago") stay fresh. */
export function useNow(ms = 1000): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

/** GET helper with loading/error state; refetches when `deps` change. */
export function useApi<T>(path: string | null, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = React.useState<T | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(Boolean(path))
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!path) return
    let cancelled = false
    setLoading(true)
    apiFetch<T>(path)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps])
  return { data, error, loading, refresh: () => setTick((t) => t + 1) }
}
