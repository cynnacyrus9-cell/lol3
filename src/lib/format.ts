const nf = new Intl.NumberFormat('en-US')
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export function num(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return digits ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : nf.format(Math.round(v))
}

export function compactNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return Math.abs(v) < 10_000 ? nf.format(Math.round(v)) : compact.format(v)
}

export function robux(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `R$ ${num(v)}`
}

export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—'
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function timeAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never'
  const d = Math.max(0, now - ms)
  if (d < 5_000) return 'just now'
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return `${Math.floor(d / 86_400_000)}d ago`
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts)
  let f = fmtCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts })
    fmtCache.set(key, f)
  }
  return f
}

export function clock(ms: number, tz: string, seconds = true): string {
  return fmt(tz, { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }).format(ms)
}

export function dateTime(ms: number, tz: string): string {
  return fmt(tz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(ms)
}

export function longDate(ms: number, tz: string): string {
  return fmt(tz, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(ms)
}

export function shortDay(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(Date.UTC(y, m - 1, d))
}

export function tzAbbrev(ms: number, tz: string): string {
  return fmt(tz, { timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? tz
}

export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null
  if (prev === 0) return cur === 0 ? 0 : null
  return (cur - prev) / prev
}
