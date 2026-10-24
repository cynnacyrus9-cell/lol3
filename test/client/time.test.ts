import { describe, expect, it } from 'vitest'
import { addDays, dayKey, dayRangeUtc, dayStartUtc, hourBucketStart, resolveRange, zonedToUtc } from '../../shared/time'

const LA = 'America/Los_Angeles'

describe('reporting timezone (America/Los_Angeles)', () => {
  it('assigns instants on either side of local midnight to the right day', () => {
    const midnight = Date.parse('2026-07-04T07:00:00Z') // 00:00 PDT
    expect(dayKey(midnight - 1, LA)).toBe('2026-07-03')
    expect(dayKey(midnight, LA)).toBe('2026-07-04')
    expect(dayStartUtc('2026-07-04', LA)).toBe(midnight)
  })

  it('handles the 23-hour spring-forward day and 25-hour fall-back day', () => {
    const [s1, e1] = dayRangeUtc('2026-03-08', LA)
    expect((e1 - s1) / 3_600_000).toBe(23)
    const [s2, e2] = dayRangeUtc('2026-11-01', LA)
    expect((e2 - s2) / 3_600_000).toBe(25)
    expect(dayStartUtc('2026-11-01', LA)).toBe(Date.parse('2026-11-01T07:00:00Z'))
    expect(dayStartUtc('2026-11-02', LA)).toBe(Date.parse('2026-11-02T08:00:00Z'))
  })

  it('resolves skipped and repeated wall-clock times deterministically', () => {
    // 02:30 does not exist on 2026-03-08 in LA; result lands after the jump.
    expect(new Date(zonedToUtc(2026, 3, 8, 2, 30, LA)).toISOString()).toBe('2026-03-08T10:30:00.000Z')
    // 01:30 happens twice on 2026-11-01; the earlier (PDT) instant is used.
    expect(new Date(zonedToUtc(2026, 11, 1, 1, 30, LA)).toISOString()).toBe('2026-11-01T08:30:00.000Z')
  })

  it('buckets the repeated 1 AM hour into two distinct hours', () => {
    const a = Date.parse('2026-11-01T08:15:00Z') // 01:15 PDT
    const b = Date.parse('2026-11-01T09:15:00Z') // 01:15 PST
    expect(hourBucketStart(a, LA)).toBe(Date.parse('2026-11-01T08:00:00Z'))
    expect(hourBucketStart(b, LA)).toBe(Date.parse('2026-11-01T09:00:00Z'))
  })

  it('works for half-hour offset zones too', () => {
    const t = Date.parse('2026-05-01T10:50:00Z') // 16:20 IST
    expect(new Date(hourBucketStart(t, 'Asia/Kolkata')).toISOString()).toBe('2026-05-01T10:30:00.000Z')
    expect(dayKey(Date.parse('2026-05-01T18:29:59Z'), 'Asia/Kolkata')).toBe('2026-05-01')
    expect(dayKey(Date.parse('2026-05-01T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-05-02')
  })

  it('does calendar arithmetic across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
  })
})

describe('report ranges', () => {
  const now = Date.parse('2026-10-24T22:15:00Z') // Sat 15:15 PDT
  it('compares today with the same elapsed time yesterday', () => {
    const r = resolveRange('today', now, LA)
    expect(r.fromDay).toBe('2026-10-24')
    expect(r.endMs).toBe(now)
    expect(r.prev!.endMs - r.prev!.startMs).toBe(now - r.startMs)
    expect(r.prev!.fromDay).toBe('2026-10-23')
  })

  it('builds 7/30-day, week and month ranges with previous periods', () => {
    expect(resolveRange('7d', now, LA).fromDay).toBe('2026-10-18')
    expect(resolveRange('30d', now, LA).fromDay).toBe('2026-09-25')
    expect(resolveRange('week', now, LA).fromDay).toBe('2026-10-19') // Monday
    const m = resolveRange('month', now, LA)
    expect(m.fromDay).toBe('2026-10-01')
    expect(m.prev!.fromDay).toBe('2026-09-01')
    expect(m.prev!.toDay).toBe('2026-09-24')
  })

  it('clamps month comparisons when last month was shorter', () => {
    const r = resolveRange('month', Date.parse('2026-03-31T20:00:00Z'), LA)
    expect(r.prev!.toDay).toBe('2026-02-28')
    expect(r.prev!.endMs).toBe(dayStartUtc('2026-03-01', LA))
  })

  it('validates custom ranges and caps them at today', () => {
    const r = resolveRange('custom', now, LA, { from: '2026-10-30', to: '2026-10-20' })
    expect(r.fromDay).toBe('2026-10-20')
    expect(r.toDay).toBe('2026-10-24')
    expect(() => resolveRange('custom', now, LA, { from: 'bad', to: '2026-10-01' })).toThrow()
  })

  it('starts "all time" at the first tracked day and has no comparison', () => {
    const r = resolveRange('all', now, LA, undefined, '2026-09-01')
    expect(r.fromDay).toBe('2026-09-01')
    expect(r.prev).toBeNull()
  })
})
