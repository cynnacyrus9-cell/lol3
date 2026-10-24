import { Settings } from 'lucide-react'
import { CcuChart } from '@/components/charts/CcuChart'
import { MetricTile, SourceDot } from '@/components/MetricTile'
import { AnimatedNumber } from '@/components/AnimatedNumber'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useLive, useNow } from '@/state/live'
import { clock, num, timeAgo } from '@/lib/format'
import { dayStartUtc } from '@shared/time'
import * as React from 'react'

/**
 * Live total = the official Roblox visit count + joins your game servers have
 * reported since Roblox last changed that count. Every real join moves it within
 * about a second. Roblox's counter can lag behind joins it has not yet counted, so
 * the displayed total never steps backwards when a new official value arrives.
 */
function useLiveVisitTotal(): number | null {
  const { live } = useLive()
  const shown = React.useRef<number | null>(null)
  const o = live?.official
  if (!o || o.visits === null) {
    shown.current = null
    return null
  }
  const raw = o.visits + (o.trackedJoinsSinceUpdate ?? 0)
  // Allow a reset if the configured universe changed (large drop).
  if (shown.current === null || raw >= shown.current || shown.current - raw > 5_000) shown.current = raw
  return shown.current
}

/**
 * The main screen: official total visits as the hero number, with the most
 * important live numbers around it.
 */
export function Visits({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { live, config } = useLive()
  const liveTotal = useLiveVisitTotal()
  const now = useNow(1000)
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const o = live?.official
  const t = live?.today
  const loading = !live
  const hasOfficial = Boolean(o && o.status !== 'unavailable' && o.visits !== null)
  const officialKind = !o || o.status === 'unavailable' ? 'unavailable' : o.status === 'stale' || o.status === 'error' ? 'stale' : 'polled'
  const perMinute = o?.visitsPerMinute ?? null
  const likeRatio = o?.upVotes != null && o?.downVotes != null && o.upVotes + o.downVotes > 0 ? (o.upVotes / (o.upVotes + o.downVotes)) * 100 : null
  const visitsPerSale = t && t.sales > 0 ? t.trackedVisits / t.sales : null
  const visitsToday = o?.visitsToday ?? null
  // If polling only started after midnight, say so instead of implying a full day.
  const sinceMidnight = o?.visitsTodayBaselineAt && t && o.visitsTodayBaselineAt > dayStartUtc(t.dayKey, tz) + 5 * 60_000 ? `since ${clock(o.visitsTodayBaselineAt, tz, false)}` : 'since midnight'

  return (
    <div className="space-y-3">
      <section className="relative overflow-hidden rounded-2xl border border-line bg-card px-5 pb-5 pt-4 shadow-[0_0_0_1px_rgba(61,219,180,0.04),0_30px_80px_-40px_rgba(61,219,180,0.35)]" aria-label="Live visits">
        <div aria-hidden className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent" />
        <div className="flex items-center justify-between">
          <span className="label-caps flex items-center gap-2 text-ink-2">
            <span className="live-dot inline-block size-2 rounded-full bg-good" aria-hidden /> Live visits
          </span>
          <SourceDot kind={officialKind} updatedAt={o?.fetchedAt} note="Official cumulative Roblox visits (all-time, including before this dashboard existed)." />
        </div>
        <div className="pt-3 text-center sm:pt-5">
          {loading ? (
            <Skeleton className="mx-auto h-24 w-3/4 max-w-xl" />
          ) : hasOfficial ? (
            <div className="hero-number text-[clamp(48px,min(11vw,11vh),128px)] font-bold leading-none text-ink">
              <AnimatedNumber value={liveTotal} format={num} durationMs={700} />
            </div>
          ) : (
            <div className="py-4">
              <div className="hero-number text-[clamp(48px,min(11vw,11vh),128px)] font-bold leading-none text-faint">—</div>
              <p className="mt-3 text-sm text-ink-2">Add your Roblox Universe ID to show official visits.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={onOpenSettings}>
                <Settings /> Open settings
              </Button>
            </div>
          )}
          <div className="label-caps mt-3 text-muted">Total visits</div>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
            <span className="inline-block size-1.5 rounded-full bg-good" aria-hidden />
            <span>
              <b className="mono text-ink">{num(live?.ccu)}</b> playing right now
            </span>
            <span className="text-faint">·</span>
            {perMinute !== null ? (
              <span>
                <b className="mono text-ink">{num(perMinute, perMinute < 10 ? 1 : 0)}</b> visits / minute
              </span>
            ) : (
              <span>
                <b className="mono text-ink">{num(live?.joinRatePerMin, 1)}</b> joins / minute <span className="text-faint">(in-game)</span>
              </span>
            )}
          </div>
          {hasOfficial ? (
            <p className="mt-2 text-[11px] text-faint">
              Official Roblox count {num(o!.visits)} (checked {timeAgo(o!.fetchedAt, now)}) + {num(o!.trackedJoinsSinceUpdate)} joins reported live by your servers since
            </p>
          ) : null}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Key numbers">
        <MetricTile label="Players now" value={live?.ccu ?? null} format={num} caption={`across ${num(live?.activeServers)} server${live?.activeServers === 1 ? '' : 's'} right now`} source="live" updatedAt={live?.serverTime} loading={loading} />
        <MetricTile
          label="Visits today"
          value={visitsToday ?? t?.trackedVisits ?? null}
          format={num}
          caption={visitsToday !== null ? `official, ${sinceMidnight}` : 'joins tracked in-game since midnight'}
          source={visitsToday !== null ? officialKind : 'live'}
          updatedAt={visitsToday !== null ? o?.fetchedAt : live?.ingest.lastEventAt}
          loading={loading}
        />
        <MetricTile label="Visits · last hour" value={o?.visitsLastHour ?? null} format={num} caption={o?.visitsLastHour != null ? 'rolling 60 minutes' : 'collecting history…'} source={officialKind} updatedAt={o?.fetchedAt} loading={loading} />
        <MetricTile label="Visits · last day" value={o?.visitsLastDay ?? null} format={num} caption={o?.visitsLastDay != null ? 'rolling 24 hours' : 'needs 24 h of history'} source={officialKind} updatedAt={o?.fetchedAt} loading={loading} />
        <MetricTile label="Peak players today" value={t?.peakCcu ?? null} format={num} caption={t?.peakAt ? `reached at ${clock(t.peakAt, tz, false)}` : 'highest concurrent today'} source="live" updatedAt={t?.peakAt} loading={loading} />
        <MetricTile label="Favorites" value={o?.favorites ?? null} format={num} caption="players who favorited the game" source={officialKind} updatedAt={o?.fetchedAt} loading={loading} />
        <MetricTile
          label="Like ratio"
          value={likeRatio}
          format={(v) => (v === null ? '—' : `${num(v, v < 10 ? 1 : 0)}%`)}
          caption={o?.upVotes != null && o?.downVotes != null ? `${num(o.upVotes)} up · ${num(o.downVotes)} down` : 'from Roblox votes'}
          source={officialKind}
          updatedAt={o?.fetchedAt}
          loading={loading}
        />
        <MetricTile
          label="Visits / sale"
          value={visitsPerSale}
          format={(v) => (v === null ? '—' : num(v))}
          caption={t ? `${num(t.sales)} sale${t.sales === 1 ? '' : 's'} today · R$ ${num(t.revenue)}` : 'tracked visits per sale today'}
          source="live"
          updatedAt={live?.ingest.lastPurchaseAt}
          note="Joins tracked in-game today ÷ verified sales today."
          loading={loading}
        />
      </section>

      <CcuChart title="Players online" description="Concurrent players across all servers" windows={['1h', '24h', '7d']} defaultWindow="24h" height={170} />
    </div>
  )
}
