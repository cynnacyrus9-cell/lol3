import { DEFAULT_TIMEZONE, isValidTimeZone } from '../shared/time'
import type { Env } from './env'

export interface AppConfig {
  gameName: string
  universeId: string | null
  placeId: string | null
  groupId: string | null
  timezone: string
  dailyGoalRobux: number | null
  milestones: number[]
  netRevenueRate: number
  officialPollSec: number
  activityRetentionDays: number
}

export const DEFAULT_MILESTONES = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000]
// Roblox pays creators 70% of game pass and developer product sales made in
// experiences (30% marketplace fee). Shown only as an *estimate*.
export const DEFAULT_NET_RATE = 0.7
export const MIN_POLL_SEC = 20

export const CONFIG_KEYS = [
  'gameName',
  'universeId',
  'placeId',
  'groupId',
  'timezone',
  'dailyGoalRobux',
  'milestones',
  'netRevenueRate',
  'officialPollSec',
  'activityRetentionDays',
] as const

function idOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (!/^\d{1,20}$/.test(s)) throw new Error('IDs must be numeric')
  return s
}

export function defaultConfig(env: Env): AppConfig {
  const tz = env.REPORTING_TIMEZONE && isValidTimeZone(env.REPORTING_TIMEZONE) ? env.REPORTING_TIMEZONE : DEFAULT_TIMEZONE
  const poll = Number(env.OFFICIAL_POLL_SEC)
  return {
    gameName: env.GAME_NAME?.trim() || 'Roadster Life',
    universeId: safe(() => idOrNull(env.ROBLOX_UNIVERSE_ID), null),
    placeId: safe(() => idOrNull(env.ROBLOX_PLACE_ID), null),
    groupId: safe(() => idOrNull(env.ROBLOX_GROUP_ID), null),
    timezone: tz,
    dailyGoalRobux: null,
    milestones: DEFAULT_MILESTONES,
    netRevenueRate: DEFAULT_NET_RATE,
    officialPollSec: Number.isFinite(poll) && poll >= MIN_POLL_SEC ? Math.round(poll) : 30,
    activityRetentionDays: 30,
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** Validates a partial update coming from the admin panel. Throws on bad input. */
export function applyConfigPatch(current: AppConfig, patch: Record<string, unknown>): AppConfig {
  const next: AppConfig = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'gameName': {
        const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) : ''
        if (!s) throw new Error('Game name cannot be empty')
        next.gameName = s
        break
      }
      case 'universeId':
      case 'placeId':
      case 'groupId':
        next[k] = idOrNull(v)
        break
      case 'timezone':
        if (typeof v !== 'string' || !isValidTimeZone(v)) throw new Error('Unknown IANA timezone')
        next.timezone = v
        break
      case 'dailyGoalRobux':
        if (v === null || v === '' || v === 0) next.dailyGoalRobux = null
        else if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1e9) next.dailyGoalRobux = v
        else throw new Error('Daily goal must be a positive whole number of Robux')
        break
      case 'milestones':
        if (!Array.isArray(v) || v.length > 30 || !v.every((x) => typeof x === 'number' && Number.isInteger(x) && x > 0 && x <= 1e10)) {
          throw new Error('Milestones must be up to 30 positive whole numbers')
        }
        next.milestones = [...new Set(v as number[])].sort((a, b) => a - b)
        break
      case 'netRevenueRate':
        if (typeof v !== 'number' || !(v > 0 && v <= 1)) throw new Error('Net revenue rate must be between 0 and 1')
        next.netRevenueRate = v
        break
      case 'officialPollSec':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_POLL_SEC || v > 3600) {
          throw new Error(`Official poll interval must be between ${MIN_POLL_SEC} and 3600 seconds`)
        }
        next.officialPollSec = v
        break
      case 'activityRetentionDays':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 365) throw new Error('Retention must be 1–365 days')
        next.activityRetentionDays = v
        break
      default:
        throw new Error(`Unknown setting: ${k}`)
    }
  }
  return next
}

export function configFromRows(env: Env, rows: { key: string; value: string }[]): AppConfig {
  let cfg = defaultConfig(env)
  for (const row of rows) {
    if (!(CONFIG_KEYS as readonly string[]).includes(row.key)) continue
    try {
      cfg = applyConfigPatch(cfg, { [row.key]: JSON.parse(row.value) })
    } catch {
      // Ignore a corrupt stored value and keep the default.
    }
  }
  return cfg
}
