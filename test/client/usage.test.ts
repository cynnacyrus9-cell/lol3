import { describe, expect, it } from 'vitest'
import { computeBudget, emptyUsage, projectDaily } from '../../worker/usage'
import { validateBatch, ValidationError } from '../../worker/validate'

const noon = Date.parse('2026-10-24T12:00:00Z')

describe('free-tier budget', () => {
  it('stays relaxed at low usage', () => {
    const b = computeBudget(emptyUsage(noon), 3, noon)
    expect(b).toMatchObject({ level: 'ok', heartbeatSec: 60, flushSec: 1, joinLeaveLogging: true })
  })

  it('slows heartbeats as the number of servers grows', () => {
    const b = computeBudget(emptyUsage(noon), 200, noon)
    // 200 servers × 86,400 / (45,000) ≈ 384 s keeps heartbeats under 45% of the allowance
    expect(b.heartbeatSec).toBeGreaterThanOrEqual(384)
  })

  it('escalates when projected Worker requests approach the daily limit', () => {
    const u = emptyUsage(noon)
    u.worker.ingest = 40_000 // half a day → projected 80,000 (80%)
    expect(computeBudget(u, 5, noon).level).toBe('elevated')
    u.worker.ingest = 47_000 // projected 94%
    const b = computeBudget(u, 5, noon)
    expect(b.level).toBe('critical')
    expect(b.flushSec).toBe(15)
  })

  it('pauses optional join/leave logging when D1 writes run out', () => {
    const u = emptyUsage(noon)
    u.d1.rowsWritten = 90_000
    const b = computeBudget(u, 5, noon)
    expect(b.joinLeaveLogging).toBe(false)
  })

  it('projects linearly to the end of the UTC day', () => {
    expect(projectDaily(1000, noon)).toBe(2000)
  })
})

describe('ingest validation', () => {
  const now = Date.now()
  const base = { v: 1, batchId: 'abcdef12-3456', sentAt: now, server: { jobId: 'job-1' } }
  it('accepts a minimal heartbeat', () => {
    expect(validateBatch(base, now).server.jobId).toBe('job-1')
  })
  it('clamps future timestamps to now', () => {
    const b = validateBatch({ ...base, events: [{ type: 'join', u: 1, j: now + 3_600_000 }] }, now)
    expect((b.events![0] as { j: number }).j).toBe(now)
  })
  it('strips markup and control characters from names', () => {
    const b = validateBatch({ ...base, events: [{ type: 'join', u: 1, j: now, n: '<img src=x>\u0007Bob' }] }, now)
    expect((b.events![0] as { n: string }).n).toBe('img src=xBob')
  })
  it('rejects unknown event types and bad versions', () => {
    expect(() => validateBatch({ ...base, events: [{ type: 'hack' }] }, now)).toThrow(ValidationError)
    expect(() => validateBatch({ ...base, v: 2 }, now)).toThrow(ValidationError)
  })
})
