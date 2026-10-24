import * as React from 'react'
import { CalendarDays, CircleDollarSign, Eye, Footprints, Gauge, Receipt, TrendingUp, Trophy, Users, Wallet } from 'lucide-react'
import { StatCard, type Comparison } from '@/components/StatCard'
import { CcuChart } from '@/components/charts/CcuChart'
import { RevenueChart } from '@/components/charts/RevenueChart'
import { VisitsChart } from '@/components/charts/VisitsChart'
import { ProductChart } from '@/components/charts/ProductChart'
import { RevenueVsCcu } from '@/components/charts/RevenueVsCcu'
import type { CcuSeries } from '@/components/charts/types'
import { ActivityFeed, FeedFilters, useFeedFilter } from '@/components/ActivityFeed'
import { RangePicker, type RangeValue } from '@/components/RangePicker'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useApi, useLive, useNow } from '@/state/live'
import { clock, compactNum, duration, num, pctChange, robux, shortDay } from '@/lib/format'
import { dayKey, dayStartUtc } from '@shared/time'
import type { Summary, Insights } from './types'

export function useTodaySummary() {
  const { revenueVersion } = useLive()
  const slow = Math.floor(Date.now() / 300_000)
  return useApi<Summary>('/api/summary?range=today', [revenueVersion, slow])
}

function cmp(cur: number | null | undefined, prev: number | null | undefined, label: string, hasPrev: boolean): Comparison {
  return { pct: hasPrev ? pctChange(cur ?? null, prev ?? null) : null, label, fallback: hasPrev ? `— vs ${label}` : `No data for ${label} yet` }
}

export function Overview() {
  const { live, config, events, showTestEvents, setShowTestEvents } = useLive()
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const now = useNow(30_000)
  const today = useTodaySummary()
  const { revenueVersion } = useLive()
  const month = useApi<Summary>('/api/summary?range=month', [revenueVersion, Math.floor(now / 300_000)])
  const ccu24 = useApi<CcuSeries>('/api/series/ccu?window=24h', [Math.floor(now / 600_000)])
  const [revRange, setRevRange] = React.useState<RangeValue>({ preset: 'today' })
  const [visitRange, setVisitRange] = React.useState<RangeValue>({ preset: 'today' })
  const [prodRange, setProdRange] = React.useState<RangeValue>({ preset: '30d' })
  const feed = useFeedFilter()
  const todayKey = dayKey(now, tz)

  const t = live?.today
  const prev = today.data?.previous
  const hasPrev = Boolean(prev && prev.daysWithData > 0)

  // Month = stored days before today + today's live counter (so it moves with each sale).
  const monthPast = month.data ? month.data.daily.filter((d) => d.day !== todayKey).reduce((a, d) => a + d.revenue, 0) : null
  const monthRevenue = monthPast !== null && t ? monthPast + t.revenue : null
  const monthPrev = month.data?.previous
  const ago = React.useMemo(() => {
    const pts = ccu24.data?.points
    if (!pts?.length) return null
    const target = now - 86_400_000
    const p = pts.reduce((best, x) => (Math.abs(x.t - target) < Math.abs(best.t - target) ? x : best), pts[0])
    return Math.abs(p.t - target) < 20 * 60_000 ? p.ccu : null
  }, [ccu24.data, now])

  const loading = !live
  const official = live?.official
  const officialKind = official?.status === 'unavailable' ? 'unavailable' : official?.status === 'stale' || official?.status === 'error' ? 'stale' : 'polled'

  return (
    <div className="space-y-5">
      <section aria-label="Key metrics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          accent
          label="Live players"
          icon={Users}
          value={live?.ccu ?? null}
          format={num}
          loading={loading}
          source={live?.ingest.status === 'live' ? 'live' : live?.ingest.status === 'stale' ? 'stale' : 'live'}
          updatedAt={live?.serverTime}
          comparison={ago !== null ? cmp(live?.ccu, ago, '24h ago', true) : { pct: null, label: '24h ago', fallback: live?.official.playing != null ? `Roblox reports ${num(live.official.playing)} playing` : 'No CCU history from 24h ago' }}
          footer={live ? `${num(live.activeServers)} server${live.activeServers === 1 ? '' : 's'}` : undefined}
        />
        <StatCard
          label="Total visits"
          icon={Eye}
          value={official?.visits ?? null}
          format={compactNum}
          loading={loading}
          source={officialKind}
          updatedAt={official?.fetchedAt}
          sourceNote="Official cumulative Roblox visits (games.roblox.com). Includes all history before this dashboard existed."
          comparison={{ pct: null, label: '', fallback: official?.visitsToday != null ? `+${num(official.visitsToday)} since ${official.visitsTodayBaselineAt && official.visitsTodayBaselineAt > dayStartUtc(todayKey, tz) + 60_000 ? clock(official.visitsTodayBaselineAt, tz, false) : 'midnight'}` : official?.status === 'unavailable' ? 'Set the Universe ID in Admin' : 'Cumulative · official Roblox count' }}
          footer={official?.visits != null ? num(official.visits) : undefined}
        />
        <StatCard
          label="Today's visits"
          icon={Footprints}
          value={t?.trackedVisits ?? null}
          format={num}
          loading={loading}
          source="live"
          updatedAt={live?.ingest.lastEventAt}
          sourceNote="Joins observed by the in-game integration since local midnight. Official Roblox visits are shown separately."
          comparison={cmp(t?.trackedVisits, prev?.trackedVisits, 'same time yesterday', hasPrev)}
          footer={official?.visitsToday != null ? `Roblox: +${num(official.visitsToday)}` : `${num(t?.uniquePlayers)} unique`}
        />
        <StatCard
          accent
          label="Robux earned today"
          icon={CircleDollarSign}
          value={t?.revenue ?? null}
          format={robux}
          loading={loading}
          source="live"
          updatedAt={live?.ingest.lastPurchaseAt}
          sourceNote="Gross Robux from verified purchases, reported the moment the item is granted."
          comparison={cmp(t?.revenue, prev?.revenue, 'same time yesterday', hasPrev)}
          footer={t && live ? `≈ R$ ${num(t.revenue * live.netRevenueRate)} net (est.)` : undefined}
        />
        <StatCard
          label="Sales today"
          icon={Receipt}
          value={t?.sales ?? null}
          format={num}
          loading={loading}
          source="live"
          updatedAt={live?.ingest.lastPurchaseAt}
          comparison={cmp(t?.sales, prev?.sales, 'same time yesterday', hasPrev)}
          footer={t ? `${num(t.devProductSales)} products · ${num(t.gamePassSales)} passes` : undefined}
        />
        <StatCard
          label="Peak CCU today"
          icon={TrendingUp}
          value={t?.peakCcu ?? null}
          format={num}
          loading={loading}
          source="live"
          updatedAt={t?.peakAt ?? live?.serverTime}
          comparison={cmp(t?.peakCcu, prev?.peakCcu, 'same time yesterday', hasPrev)}
          footer={t?.peakAt ? `at ${clock(t.peakAt, tz, false)}` : undefined}
        />
        <StatCard
          label="Revenue this month"
          icon={CalendarDays}
          value={monthRevenue}
          format={robux}
          loading={loading || (month.loading && !month.data)}
          source="computed"
          updatedAt={live?.ingest.lastPurchaseAt}
          comparison={cmp(monthRevenue, monthPrev?.revenue, 'same point last month', Boolean(monthPrev && monthPrev.daysWithData > 0))}
          footer={month.data ? `${num(month.data.current.sales + 0)} sales` : undefined}
        />
        <StatCard
          label="All-time tracked revenue"
          icon={Wallet}
          value={live?.allTime.revenue ?? null}
          format={robux}
          loading={loading}
          source="computed"
          updatedAt={live?.ingest.lastPurchaseAt}
          sourceNote="Only purchases recorded since this integration was installed. Not your lifetime Roblox earnings."
          comparison={{ pct: null, label: '', fallback: live?.allTime.since ? `Since ${shortDay(dayKey(live.allTime.since, tz))}` : 'No purchases recorded yet' }}
          footer={live ? `${num(live.allTime.sales)} sales` : undefined}
        />
      </section>

      <div className="grid grid-cols-1 gap-5 2xl:grid-cols-3">
        <div className="2xl:col-span-2">
          <CcuChart />
        </div>
        <Card className="flex flex-col">
          <CardHeader>
            <div>
              <CardTitle>Live activity</CardTitle>
              <CardDescription>Joins, sales, servers and milestones as they happen</CardDescription>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-muted">
              <Switch checked={showTestEvents} onCheckedChange={setShowTestEvents} aria-label="Show Studio test events" /> Test events
            </label>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col">
            <FeedFilters {...feed} />
            <div className="mt-2 max-h-[300px] flex-1 overflow-y-auto pr-1">
              <ActivityFeed events={events} tz={tz} cats={feed.cats} showTest={showTestEvents} limit={50} />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <RevenueChart range={revRange} controls={<RangePicker value={revRange} onChange={setRevRange} today={todayKey} />} />
        <VisitsChart range={visitRange} controls={<RangePicker value={visitRange} onChange={setVisitRange} today={todayKey} />} />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <ProductChart range={prodRange} controls={<RangePicker value={prodRange} onChange={setProdRange} today={todayKey} />} />
        <RevenueVsCcu />
      </div>

      <TodayInsights summary={today.data} loading={today.loading && !today.data} />
    </div>
  )
}

function Row({ label, cur, prev, format, hasPrev }: { label: string; cur: number | null | undefined; prev: number | null | undefined; format: (v: number | null | undefined) => string; hasPrev: boolean }) {
  const pct = hasPrev ? pctChange(cur ?? null, prev ?? null) : null
  return (
    <tr className="border-t border-line">
      <td className="py-2 pr-2 text-[13px] text-ink-2">{label}</td>
      <td className="tabular py-2 text-right text-[13px] font-medium text-ink">{format(cur)}</td>
      <td className="tabular py-2 text-right text-[13px] text-muted">{hasPrev ? format(prev) : '—'}</td>
      <td className={`tabular py-2 pl-2 text-right text-[12px] ${pct === null ? 'text-faint' : pct >= 0 ? 'text-[#4ee39a]' : 'text-[#ff7b7b]'}`}>
        {pct === null ? '—' : `${pct >= 0 ? '▲ +' : '▼ '}${(pct * 100).toFixed(0)}%`}
      </td>
    </tr>
  )
}

function TodayInsights({ summary, loading }: { summary: Summary | null; loading: boolean }) {
  const { live, config } = useLive()
  const now = useNow(60_000)
  const insights = useApi<Insights>('/api/insights', [live?.allTime.sales ?? 0])
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const t = live?.today
  const p = summary?.previous ?? null
  const c = summary?.current ?? null
  const hasPrev = Boolean(p && p.daysWithData > 0)
  const hours = Math.max((now - dayStartUtc(dayKey(now, tz), tz)) / 3_600_000, 1 / 60)
  const prevHours = summary?.range.prev ? Math.max((summary.range.prev.endMs - summary.range.prev.startMs) / 3_600_000, 1 / 60) : null
  const goal = live?.dailyGoalRobux ?? null
  const goalPct = goal && t ? Math.min(1, t.revenue / goal) : null
  const rpm = (x: { revenue: number; trackedVisits: number } | null | undefined) => (x && x.trackedVisits > 0 ? (x.revenue / x.trackedVisits) * 1000 : null)
  const rpp = (x: { revenue: number; uniquePlayers: number } | null | undefined) => (x && x.uniquePlayers > 0 ? x.revenue / x.uniquePlayers : null)
  const conv = (x: { payingPlayers: number; uniquePlayers: number } | null | undefined) => (x && x.uniquePlayers > 0 ? x.payingPlayers / x.uniquePlayers : null)
  const pctFmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`)
  const liveCur = t ? { ...c, revenue: t.revenue, sales: t.sales, trackedVisits: t.trackedVisits, uniquePlayers: t.uniquePlayers, payingPlayers: c?.payingPlayers ?? 0 } : null

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Today vs. yesterday</CardTitle>
            <CardDescription>Compared with yesterday up to the same time of day ({config?.timezone})</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-faint">
                    <th className="pb-2 font-medium">Metric</th>
                    <th className="pb-2 text-right font-medium">Today</th>
                    <th className="pb-2 text-right font-medium">Yesterday</th>
                    <th className="pb-2 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  <Row label="Robux earned (gross)" cur={t?.revenue} prev={p?.revenue} format={robux} hasPrev={hasPrev} />
                  <Row label="Robux per hour" cur={t ? t.revenue / hours : null} prev={p && prevHours ? p.revenue / prevHours : null} format={(v) => robux(v === null || v === undefined ? v : Math.round(v))} hasPrev={hasPrev} />
                  <Row label="Sales" cur={t?.sales} prev={p?.sales} format={num} hasPrev={hasPrev} />
                  <Row label="Average Robux per purchase" cur={t && t.sales ? t.revenue / t.sales : null} prev={p && p.sales ? p.revenue / p.sales : null} format={(v) => (v == null ? '—' : `R$ ${num(v, 1)}`)} hasPrev={hasPrev} />
                  <Row label="Tracked visits" cur={t?.trackedVisits} prev={p?.trackedVisits} format={num} hasPrev={hasPrev} />
                  <Row label="Unique players" cur={t?.uniquePlayers} prev={p?.uniquePlayers} format={num} hasPrev={hasPrev} />
                  <Row label="Peak CCU" cur={t?.peakCcu} prev={p?.peakCcu} format={num} hasPrev={hasPrev} />
                  <Row label="Average CCU" cur={t?.avgCcu} prev={p?.avgCcu} format={(v) => num(v, 1)} hasPrev={hasPrev} />
                  <Row label="Average session" cur={t?.avgSessionSec} prev={p?.avgSessionSec} format={duration} hasPrev={hasPrev} />
                  <Row label="Revenue per active player" cur={rpp(liveCur)} prev={rpp(p)} format={(v) => (v == null ? '—' : `R$ ${num(v, 2)}`)} hasPrev={hasPrev} />
                  <Row label="Revenue per 1,000 visits" cur={rpm(liveCur)} prev={rpm(p)} format={(v) => (v == null ? '—' : `R$ ${num(v)}`)} hasPrev={hasPrev} />
                  <Row label="Paying-player conversion" cur={conv(liveCur)} prev={conv(p)} format={pctFmt} hasPrev={hasPrev} />
                </tbody>
              </table>
              {!hasPrev ? <p className="mt-3 text-xs text-muted">Yesterday has no tracked data yet — comparisons appear after a full day of tracking.</p> : null}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Daily revenue goal</CardTitle>
              <CardDescription>{goal ? `Target R$ ${num(goal)} (gross)` : 'Set a goal in Admin → Settings'}</CardDescription>
            </div>
            <Gauge className="size-4 text-faint" aria-hidden />
          </CardHeader>
          <CardContent>
            {goal && t ? (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="tabular text-2xl font-semibold">{(goalPct! * 100).toFixed(0)}%</span>
                  <span className="tabular text-xs text-muted">
                    {robux(t.revenue)} / {robux(goal)}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={Math.round(goalPct! * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${goalPct! * 100}%` }} />
                </div>
              </>
            ) : (
              <p className="text-sm text-muted">No goal configured.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Highlights</CardTitle>
              <CardDescription>From recorded history</CardDescription>
            </div>
            <Trophy className="size-4 text-faint" aria-hidden />
          </CardHeader>
          <CardContent className="space-y-3 text-[13px]">
            {insights.loading && !insights.data ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <>
                <div className="flex justify-between gap-2">
                  <span className="text-ink-2">Highest-earning day</span>
                  <span className="tabular text-right font-medium">{insights.data?.highestEarningDay ? `${robux(insights.data.highestEarningDay.revenue)} · ${shortDay(insights.data.highestEarningDay.day)}` : '—'}</span>
                </div>
                <div>
                  <div className="text-ink-2">Best sellers (30 days)</div>
                  {insights.data?.bestSellers.length ? (
                    <ol className="mt-1 space-y-1">
                      {insights.data.bestSellers.map((b, i) => (
                        <li key={`${b.kind}:${b.product_id}`} className="flex justify-between gap-2 text-[12px]">
                          <span className="truncate text-ink">
                            {i + 1}. {b.name ?? `#${b.product_id}`}
                          </span>
                          <span className="tabular shrink-0 text-muted">
                            {num(b.sales)} · {robux(b.revenue)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-[12px] text-muted">No sales yet.</p>
                  )}
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-ink-2">Avg server uptime (7d)</span>
                  <span className="tabular font-medium">{duration(insights.data?.servers7d.avgUptimeSec)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-ink-2">Servers lost heartbeat (7d)</span>
                  <span className="tabular font-medium">
                    {num(insights.data?.servers7d.heartbeatTimeouts)} / {num(insights.data?.servers7d.count)}
                  </span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
