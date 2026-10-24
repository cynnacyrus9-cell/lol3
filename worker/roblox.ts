// Shared, server-side access to official Roblox data. Browsers never call Roblox:
// the Durable Object polls on one schedule and every dashboard shares the result.

export class RobloxRateLimitError extends Error {
  constructor(public retryAfterSec: number) {
    super(`Roblox rate limited the request (retry after ${retryAfterSec}s)`)
  }
}

export interface OfficialGame {
  universeId: number
  name: string | null
  rootPlaceId: number | null
  visits: number
  playing: number | null
  favorites: number | null
  updated: string | null
}

const UA = 'RoadsterLifeAnalytics/1.0 (+Cloudflare Worker)'

async function getJson(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { accept: 'application/json', 'user-agent': UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) })
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'))
    throw new RobloxRateLimitError(Number.isFinite(ra) && ra > 0 ? ra : 60)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Roblox API ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
  }
  return res.json()
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * Official cumulative visits and current players for a universe from the
 * documented Games API (games.roblox.com/v1/games?universeIds=…). No
 * authentication is needed; the counters are maintained by Roblox and are
 * themselves refreshed on Roblox's own schedule.
 */
export async function fetchOfficialGame(universeId: string): Promise<OfficialGame> {
  if (!/^\d{1,20}$/.test(universeId)) throw new Error('Universe ID must be numeric')
  const body = (await getJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`)) as { data?: unknown }
  const row = Array.isArray(body?.data) ? (body.data as Record<string, unknown>[]).find((d) => String(d.id) === universeId) : undefined
  if (!row) throw new Error(`Roblox returned no game for universe ${universeId}`)
  const visits = num(row.visits)
  if (visits === null) throw new Error('Roblox response is missing a valid "visits" value')
  return {
    universeId: Number(universeId),
    name: typeof row.name === 'string' ? row.name : null,
    rootPlaceId: num(row.rootPlaceId),
    visits,
    playing: num(row.playing),
    favorites: num(row.favoritedCount),
    updated: typeof row.updated === 'string' ? row.updated : null,
  }
}

/**
 * Like/dislike counts (games.roblox.com/v1/games/votes?universeIds=…), used for
 * the like ratio. Returns null when Roblox does not return the universe.
 */
export async function fetchVotes(universeId: string): Promise<{ upVotes: number; downVotes: number } | null> {
  if (!/^\d{1,20}$/.test(universeId)) throw new Error('Universe ID must be numeric')
  const body = (await getJson(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`)) as { data?: unknown }
  const row = Array.isArray(body?.data) ? (body.data as Record<string, unknown>[]).find((d) => String(d.id) === universeId) : undefined
  const up = num(row?.upVotes)
  const down = num(row?.downVotes)
  return up === null || down === null ? null : { upVotes: up, downVotes: down }
}

/** Resolves a place ID to its universe ID (apis.roblox.com/universes/v1/places/{id}/universe). */
export async function lookupUniverseId(placeId: string): Promise<string> {
  if (!/^\d{1,20}$/.test(placeId)) throw new Error('Place ID must be numeric')
  const body = (await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)) as { universeId?: unknown }
  if (typeof body?.universeId !== 'number') throw new Error('Roblox did not return a universe for that place')
  return String(body.universeId)
}

/**
 * Verifies an Open Cloud API key by reading the universe resource
 * (GET apis.roblox.com/cloud/v2/universes/{id}). The key never leaves the Worker.
 */
export async function verifyOpenCloudKey(universeId: string, apiKey: string): Promise<{ displayName: string | null; visibility: string | null }> {
  if (!/^\d{1,20}$/.test(universeId)) throw new Error('Universe ID must be numeric')
  const body = (await getJson(`https://apis.roblox.com/cloud/v2/universes/${universeId}`, { headers: { 'x-api-key': apiKey } })) as Record<string, unknown>
  return {
    displayName: typeof body.displayName === 'string' ? body.displayName : null,
    visibility: typeof body.visibility === 'string' ? body.visibility : null,
  }
}

/** Exponential backoff for the official poller; honours Retry-After on 429. */
export function nextPollDelayMs(baseSec: number, failures: number, retryAfterSec?: number): number {
  if (failures <= 0) return baseSec * 1000
  const backoff = Math.min(baseSec * 2 ** failures, 15 * 60) * 1000
  return Math.max(backoff, (retryAfterSec ?? 0) * 1000)
}
