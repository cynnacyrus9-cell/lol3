import type { IngestBatch, IngestEvent, IngestPlayer, IngestServerInfo, PurchaseKind } from '../shared/types'

export const MAX_BODY_BYTES = 64 * 1024
export const MAX_EVENTS = 200
export const MAX_PLAYERS = 250
export const CLOCK_SKEW_MS = 5 * 60_000
export const MAX_PURCHASE_AGE_MS = 30 * 24 * 3600_000

export class ValidationError extends Error {}

const KINDS: PurchaseKind[] = ['developer_product', 'game_pass']

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function posInt(v: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > max) throw new ValidationError(`${field} must be a positive integer`)
  return v
}

function nonNegInt(v: unknown, field: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new ValidationError(`${field} must be an integer between 0 and ${max}`)
  return v
}

function optPosInt(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null || v === 0) return undefined
  return posInt(v, field)
}

function timestamp(v: unknown, field: string): number {
  // Roblox servers report UnixTimestampMillis; accept seconds defensively.
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new ValidationError(`${field} must be a timestamp`)
  const ms = v < 1e11 ? Math.round(v * 1000) : Math.round(v)
  if (ms < Date.UTC(2020, 0, 1)) throw new ValidationError(`${field} is not a plausible timestamp`)
  return ms
}

/** Strips control characters and caps length; returns undefined for empty input. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max)
  return s.length ? s : undefined
}

const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/
const BATCH_ID_RE = /^[A-Za-z0-9{}-]{8,80}$/
const PURCHASE_ID_RE = /^[A-Za-z0-9_{}:-]{1,100}$/

/**
 * Validates and normalises a batch. Timestamps in the future (beyond clock skew)
 * are clamped to `now` rather than trusted.
 */
export function validateBatch(raw: unknown, now: number): IngestBatch {
  if (!isObj(raw)) throw new ValidationError('Body must be a JSON object')
  if (raw.v !== 1) throw new ValidationError('Unsupported payload version')
  if (typeof raw.batchId !== 'string' || !BATCH_ID_RE.test(raw.batchId)) throw new ValidationError('batchId is invalid')
  const sentAt = timestamp(raw.sentAt, 'sentAt')
  if (Math.abs(sentAt - now) > CLOCK_SKEW_MS) throw new ValidationError('sentAt is outside the allowed clock window (replay protection)')

  if (!isObj(raw.server)) throw new ValidationError('server is required')
  const s = raw.server
  if (typeof s.jobId !== 'string' || !JOB_ID_RE.test(s.jobId)) throw new ValidationError('server.jobId is invalid')
  const server: IngestServerInfo = {
    jobId: s.jobId,
    universeId: optPosInt(s.universeId, 'server.universeId'),
    placeId: optPosInt(s.placeId, 'server.placeId'),
    placeVersion: s.placeVersion === undefined ? undefined : nonNegInt(s.placeVersion, 'server.placeVersion', 1e9),
    privateServer: s.privateServer === true,
    studio: s.studio === true,
    startedAt: s.startedAt === undefined ? undefined : clamp(timestamp(s.startedAt, 'server.startedAt'), now),
  }

  let players: IngestPlayer[] | undefined
  if (raw.players !== undefined) {
    if (!Array.isArray(raw.players) || raw.players.length > MAX_PLAYERS) throw new ValidationError(`players must be an array of at most ${MAX_PLAYERS}`)
    const seen = new Set<number>()
    players = []
    for (const p of raw.players) {
      if (!isObj(p)) throw new ValidationError('players entries must be objects')
      const u = posInt(p.u, 'players[].u')
      if (seen.has(u)) continue
      seen.add(u)
      players.push({ u, j: clamp(timestamp(p.j, 'players[].j'), now), n: cleanText(p.n, 40) })
    }
  }

  const events: IngestEvent[] = []
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) throw new ValidationError(`events must be an array of at most ${MAX_EVENTS}`)
    for (const e of raw.events) events.push(validateEvent(e, now))
  }

  return { v: 1, batchId: raw.batchId, sentAt, server, players, events, synthetic: raw.synthetic === true }
}

function validateEvent(e: unknown, now: number): IngestEvent {
  if (!isObj(e)) throw new ValidationError('events entries must be objects')
  switch (e.type) {
    case 'join':
      return { type: 'join', u: posInt(e.u, 'join.u'), j: clamp(timestamp(e.j, 'join.j'), now), n: cleanText(e.n, 40) }
    case 'leave': {
      const j = clamp(timestamp(e.j, 'leave.j'), now)
      const at = Math.max(j, clamp(timestamp(e.at, 'leave.at'), now))
      return { type: 'leave', u: posInt(e.u, 'leave.u'), j, at, n: cleanText(e.n, 40) }
    }
    case 'purchase': {
      if (!KINDS.includes(e.kind as PurchaseKind)) throw new ValidationError('purchase.kind is invalid')
      const kind = e.kind as PurchaseKind
      const at = clamp(timestamp(e.at, 'purchase.at'), now)
      if (now - at > MAX_PURCHASE_AGE_MS) throw new ValidationError('purchase is older than 30 days')
      let purchaseId: string | undefined
      if (kind === 'developer_product') {
        if (typeof e.purchaseId !== 'string' || !PURCHASE_ID_RE.test(e.purchaseId)) {
          throw new ValidationError('developer product purchases require the receipt PurchaseId')
        }
        purchaseId = e.purchaseId
      }
      return {
        type: 'purchase',
        kind,
        productId: posInt(e.productId, 'purchase.productId'),
        robux: nonNegInt(e.robux, 'purchase.robux', 10_000_000),
        u: posInt(e.u, 'purchase.u'),
        at,
        purchaseId,
        productName: cleanText(e.productName, 80),
        n: cleanText(e.n, 40),
        placeIdWherePurchased: optPosInt(e.placeIdWherePurchased, 'purchase.placeIdWherePurchased'),
        currencyType: cleanText(e.currencyType, 20),
      }
    }
    case 'server_close':
      return { type: 'server_close', at: clamp(timestamp(e.at, 'server_close.at'), now) }
    case 'catalog': {
      if (!KINDS.includes(e.kind as PurchaseKind)) throw new ValidationError('catalog.kind is invalid')
      const price = e.price === undefined || e.price === null ? null : nonNegInt(e.price, 'catalog.price', 10_000_000)
      return { type: 'catalog', kind: e.kind as PurchaseKind, productId: posInt(e.productId, 'catalog.productId'), name: cleanText(e.name, 80), price }
    }
    default:
      throw new ValidationError(`Unknown event type`)
  }
}

function clamp(ms: number, now: number): number {
  return ms > now + 60_000 ? now : ms
}
