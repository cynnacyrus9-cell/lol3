// Timezone-aware reporting helpers shared by the Worker and the dashboard.
// All stored timestamps are UTC epoch milliseconds; a "day key" (YYYY-MM-DD)
// is always a calendar day in the reporting timezone (default America/Los_Angeles).

export const DEFAULT_TIMEZONE = 'America/Los_Angeles'
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(tz, f)
  }
  return f
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function zonedParts(ms: number, tz: string): ZonedParts {
  const out: Record<string, number> = {}
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  }
}

/** Offset in ms such that localWallClock = utc + offset. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/**
 * Converts a wall-clock time in `tz` to UTC ms. For wall-clock times skipped by
 * a DST jump the result lands just after the jump; for repeated times the
 * earlier instant is returned.
 */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  let guess = wall - tzOffsetMs(wall, tz)
  // Two refinement passes settle every real-world transition.
  for (let i = 0; i < 2; i++) {
    const next = wall - tzOffsetMs(guess, tz)
    if (next === guess) break
    guess = next
  }
  // Prefer the earlier instant for ambiguous (repeated) wall-clock times.
  const earlier = guess - HOUR
  const pe = zonedParts(earlier, tz)
  if (Date.UTC(pe.year, pe.month - 1, pe.day, pe.hour, pe.minute) === wall) return earlier
  return guess
}

export function dayKey(ms: number, tz: string): string {
  const p = zonedParts(ms, tz)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

export function parseDayKey(key: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) throw new Error(`Invalid day key: ${key}`)
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid day key: ${key}`)
  }
  return { year, month, day }
}

export function isDayKey(key: unknown): key is string {
  if (typeof key !== 'string') return false
  try {
    parseDayKey(key)
    return true
  } catch {
    return false
  }
}

/** Pure calendar arithmetic on a day key (no timezone involved). */
export function addDays(key: string, n: number): string {
  const { year, month, day } = parseDayKey(key)
  const d = new Date(Date.UTC(year, month - 1, day + n))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function dayStartUtc(key: string, tz: string): number {
  const { year, month, day } = parseDayKey(key)
  return zonedToUtc(year, month, day, 0, 0, tz)
}

/** [start, end) of a local calendar day in UTC ms. Length is 23h/24h/25h around DST. */
export function dayRangeUtc(key: string, tz: string): [number, number] {
  return [dayStartUtc(key, tz), dayStartUtc(addDays(key, 1), tz)]
}

export function daysBetween(fromKey: string, toKey: string): number {
  const a = parseDayKey(fromKey)
  const b = parseDayKey(toKey)
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY)
}

export function listDays(fromKey: string, toKey: string): string[] {
  const n = daysBetween(fromKey, toKey)
  const out: string[] = []
  for (let i = 0; i <= n; i++) out.push(addDays(fromKey, i))
  return out
}

/** Start (UTC ms) of the local clock hour containing `ms`. Correct across DST changes. */
export function hourBucketStart(ms: number, tz: string): number {
  const off = tzOffsetMs(ms, tz)
  const local = ms + off
  return local - (((local % HOUR) + HOUR) % HOUR) - off
}

export function weekStartKey(key: string): string {
  // Weeks start on Monday for "this week" reporting.
  const { year, month, day } = parseDayKey(key)
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay() // 0 = Sunday
  const back = (dow + 6) % 7
  return addDays(key, -back)
}

export function monthStartKey(key: string): string {
  return `${key.slice(0, 7)}-01`
}

export type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'week' | 'month' | 'all' | 'custom'

export const RANGE_PRESETS: RangePreset[] = ['today', 'yesterday', '7d', '30d', 'week', 'month', 'all', 'custom']

export interface ResolvedRange {
  preset: RangePreset
  fromDay: string
  toDay: string // inclusive
  startMs: number
  endMs: number // exclusive, capped at `now`
  prev: { fromDay: string; toDay: string; startMs: number; endMs: number } | null
  label: string
  prevLabel: string | null
}

/**
 * Resolves a reporting range. Partial ranges that include "now" are compared
 * with the same elapsed portion of the previous period so comparisons are fair
 * (e.g. today until 3:15 PM vs yesterday until 3:15 PM).
 */
export function resolveRange(
  preset: RangePreset,
  nowMs: number,
  tz: string,
  custom?: { from?: string; to?: string },
  earliestDay?: string,
): ResolvedRange {
  const today = dayKey(nowMs, tz)
  const todayStart = dayStartUtc(today, tz)
  const elapsed = nowMs - todayStart

  const span = (fromDay: string, toDay: string) => {
    const startMs = dayStartUtc(fromDay, tz)
    const endMs = Math.min(dayStartUtc(addDays(toDay, 1), tz), nowMs)
    return { fromDay, toDay, startMs, endMs }
  }
  // Previous period of equal day length; if the current period is still running
  // it is truncated to the same elapsed time on its final day.
  const previous = (fromDay: string, toDay: string) => {
    const len = daysBetween(fromDay, toDay) + 1
    const pFrom = addDays(fromDay, -len)
    const pTo = addDays(toDay, -len)
    const p = span(pFrom, pTo)
    if (toDay === today) p.endMs = Math.min(p.endMs, dayStartUtc(pTo, tz) + elapsed)
    return p
  }

  switch (preset) {
    case 'today': {
      const prevDay = addDays(today, -1)
      const pStart = dayStartUtc(prevDay, tz)
      return {
        preset,
        ...span(today, today),
        prev: { fromDay: prevDay, toDay: prevDay, startMs: pStart, endMs: Math.min(pStart + elapsed, todayStart) },
        label: 'Today',
        prevLabel: 'same time yesterday',
      }
    }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { preset, ...span(y, y), prev: span(addDays(y, -1), addDays(y, -1)), label: 'Yesterday', prevLabel: 'the day before' }
    }
    case '7d':
    case '30d': {
      const n = preset === '7d' ? 7 : 30
      const from = addDays(today, -(n - 1))
      return { preset, ...span(from, today), prev: previous(from, today), label: `Last ${n} days`, prevLabel: `previous ${n} days` }
    }
    case 'week': {
      const from = weekStartKey(today)
      const prevFrom = addDays(from, -7)
      const prevTo = addDays(today, -7)
      const prev = span(prevFrom, prevTo)
      prev.endMs = Math.min(prev.endMs, dayStartUtc(prevTo, tz) + elapsed)
      return { preset, ...span(from, today), prev, label: 'This week', prevLabel: 'same point last week' }
    }
    case 'month': {
      const from = monthStartKey(today)
      const prevMonthEnd = addDays(from, -1)
      const prevFrom = monthStartKey(prevMonthEnd)
      const dayOfMonth = daysBetween(from, today)
      // Clamp to the previous month's length (e.g. Mar 31 compares with all of Feb).
      const target = addDays(prevFrom, dayOfMonth)
      const clamped = target > prevMonthEnd
      const prevTo = clamped ? prevMonthEnd : target
      const prev = span(prevFrom, prevTo)
      if (!clamped) prev.endMs = Math.min(prev.endMs, dayStartUtc(prevTo, tz) + elapsed)
      return { preset, ...span(from, today), prev, label: 'This month', prevLabel: 'same point last month' }
    }
    case 'all': {
      const from = earliestDay && earliestDay <= today ? earliestDay : today
      return { preset, ...span(from, today), prev: null, label: 'All time', prevLabel: null }
    }
    case 'custom': {
      let from = custom?.from
      let to = custom?.to
      if (!isDayKey(from) || !isDayKey(to)) throw new Error('Custom ranges need from and to as YYYY-MM-DD')
      if (from > to) [from, to] = [to, from]
      if (to > today) to = today
      if (from > today) from = today
      if (daysBetween(from, to) > 3660) throw new Error('Custom ranges are limited to 10 years')
      return { preset, ...span(from, to), prev: previous(from, to), label: `${from} → ${to}`, prevLabel: 'previous period' }
    }
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
