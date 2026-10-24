import * as React from 'react'
import type { ActivityEvent } from '@shared/types'
import { ActivityFeed, FeedFilters, useFeedFilter } from '@/components/ActivityFeed'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useLive } from '@/state/live'
import { apiFetch } from '@/lib/api'

export function Activity() {
  const { events, config, showTestEvents, setShowTestEvents } = useLive()
  const tz = config?.timezone ?? 'America/Los_Angeles'
  const feed = useFeedFilter()
  const [older, setOlder] = React.useState<ActivityEvent[]>([])
  const [loading, setLoading] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const all = React.useMemo(() => {
    const map = new Map<number, ActivityEvent>()
    for (const e of [...events, ...older]) map.set(e.seq, e)
    return [...map.values()].sort((a, b) => b.seq - a.seq)
  }, [events, older])

  const loadMore = async () => {
    const oldest = all[all.length - 1]?.seq
    setLoading(true)
    setError(null)
    try {
      const q = new URLSearchParams({ limit: '100', categories: [...feed.cats].join(','), includeTest: showTestEvents ? '1' : '0' })
      if (oldest) q.set('before', String(oldest))
      const r = await apiFetch<{ events: ActivityEvent[]; hasMore: boolean }>(`/api/activity?${q}`)
      setOlder((cur) => [...cur, ...r.events])
      if (!r.hasMore) setDone(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Activity feed</CardTitle>
          <CardDescription>Stored for {config?.activityRetentionDays ?? 30} days. New events appear instantly.</CardDescription>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <Switch checked={showTestEvents} onCheckedChange={setShowTestEvents} /> Show Studio test events
        </label>
      </CardHeader>
      <CardContent>
        <FeedFilters {...feed} />
        <div className="mt-3">
          <ActivityFeed events={all} tz={tz} cats={feed.cats} showTest={showTestEvents} limit={5000} />
        </div>
        {error ? <p className="mt-3 text-sm text-[#ff9b9b]">{error}</p> : null}
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={loadMore} disabled={loading || done}>
            {done ? 'No older events' : loading ? 'Loading…' : 'Load older events'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
