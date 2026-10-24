// Wire types shared between the Worker (Durable Object hub) and the dashboard.

export type DataOrigin = 'live' | 'studio' | 'synthetic'
export type PurchaseKind = 'developer_product' | 'game_pass'
export type AmountSource = 'receipt' | 'list_price'

export type ActivityType =
  | 'player_join'
  | 'player_leave'
  | 'purchase'
  | 'ccu_peak'
  | 'server_open'
  | 'server_close'
  | 'milestone'
  | 'goal_reached'

export type ActivityCategory = 'players' | 'sales' | 'servers' | 'milestones'

export const ACTIVITY_CATEGORY: Record<ActivityType, ActivityCategory> = {
  player_join: 'players',
  player_leave: 'players',
  purchase: 'sales',
  ccu_peak: 'milestones',
  server_open: 'servers',
  server_close: 'servers',
  milestone: 'milestones',
  goal_reached: 'milestones',
}

export interface ActivityEvent {
  seq: number
  type: ActivityType
  category: ActivityCategory
  at: number
  source: DataOrigin
  data: Record<string, unknown>
}

export interface SaleEvent {
  dedupeKey: string
  kind: PurchaseKind
  productId: number
  productName: string | null
  robux: number
  amountSource: AmountSource
  userId: number | null
  username: string | null
  purchasedAt: number
  receivedAt: number
  source: DataOrigin
}

export interface ServerLive {
  jobId: string
  placeId: number | null
  players: number
  startedAt: number
  lastSeenAt: number
  heartbeatSec: number
  source: DataOrigin
  privateServer: boolean
}

export type SourceStatus = 'live' | 'delayed' | 'stale' | 'unavailable' | 'error' | 'waiting'

export interface OfficialMetrics {
  status: SourceStatus
  visits: number | null
  playing: number | null
  favorites: number | null
  name: string | null
  rootPlaceId: number | null
  fetchedAt: number | null
  changedAt: number | null
  lastError: string | null
  nextPollAt: number | null
  pollSec: number
  visitsToday: number | null
  visitsTodayBaselineAt: number | null
  /** Official visits in the rolling last 60 minutes / 24 hours (null until enough history exists). */
  visitsLastHour: number | null
  visitsLastDay: number | null
  /** Average official visits per minute over the last 15 minutes. */
  visitsPerMinute: number | null
  upVotes: number | null
  downVotes: number | null
  /** Joins seen in-game since Roblox last changed its visit counter (live, not part of the official number). */
  trackedJoinsSinceUpdate: number
}

export interface TodayStats {
  dayKey: string
  revenue: number
  sales: number
  devProductRevenue: number
  gamePassRevenue: number
  devProductSales: number
  gamePassSales: number
  trackedVisits: number
  uniquePlayers: number
  peakCcu: number
  peakAt: number | null
  avgCcu: number | null
  sessionsEnded: number
  sessionSecondsTotal: number
  avgSessionSec: number | null
  firstTrackedAt: number | null
}

export interface BudgetStatus {
  level: 'ok' | 'elevated' | 'critical'
  heartbeatSec: number
  flushSec: number
  joinLeaveLogging: boolean
  snapshotEverySec: number
  messages: string[]
}

export interface LiveSnapshot {
  serverTime: number
  seq: number
  mode: 'production' | 'development'
  tz: string
  ccu: number
  activeServers: number
  servers: ServerLive[]
  joinsLast5m: number
  leavesLast5m: number
  joinRatePerMin: number
  today: TodayStats
  allTime: { revenue: number; sales: number; since: number | null }
  official: OfficialMetrics
  ingest: { status: SourceStatus; lastEventAt: number | null; lastPurchaseAt: number | null; lastHeartbeatAt: number | null }
  budget: BudgetStatus
  viewers: number
  dailyGoalRobux: number | null
  netRevenueRate: number
}

export type ServerMessage =
  | { t: 'hello'; live: LiveSnapshot; missed: ActivityEvent[]; gap: boolean }
  | { t: 'live'; live: LiveSnapshot }
  | { t: 'event'; event: ActivityEvent }
  | { t: 'sale'; sale: SaleEvent; seq: number }
  | { t: 'notice'; level: 'info' | 'warning'; message: string }

// ----- Ingestion payload sent by the Roblox server module -----

export interface IngestServerInfo {
  jobId: string
  universeId?: number
  placeId?: number
  placeVersion?: number
  privateServer?: boolean
  studio?: boolean
  startedAt?: number
}

export interface IngestPlayer {
  u: number
  j: number
  n?: string
}

export type IngestEvent =
  | { type: 'join'; u: number; j: number; n?: string }
  | { type: 'leave'; u: number; j: number; at: number; n?: string }
  | {
      type: 'purchase'
      kind: PurchaseKind
      productId: number
      robux: number
      u: number
      at: number
      purchaseId?: string
      productName?: string
      n?: string
      placeIdWherePurchased?: number
      currencyType?: string
    }
  | { type: 'server_close'; at: number }
  | { type: 'catalog'; kind: PurchaseKind; productId: number; name?: string; price?: number | null }

export interface IngestBatch {
  v: 1
  batchId: string
  sentAt: number
  server: IngestServerInfo
  players?: IngestPlayer[]
  events?: IngestEvent[]
  synthetic?: boolean
}

export interface IngestResponse {
  ok: boolean
  duplicate?: boolean
  accepted: number
  duplicates: number
  rejected: number
  heartbeatSec: number
  flushSec: number
  catalogRequest?: { kind: PurchaseKind; productId: number }[]
  error?: string
}

export interface ProductConfig {
  kind: PurchaseKind
  productId: number
  name: string | null
  priceRobux: number | null
}

export interface PublicConfig {
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
  products: ProductConfig[]
  mode: 'production' | 'development'
  authMode: 'access' | 'password' | 'none'
  secrets: Record<string, boolean>
}
