import type { ResolvedRange } from '@shared/time'

export interface Totals {
  revenue: number
  sales: number
  devProductRevenue: number
  devProductSales: number
  gamePassRevenue: number
  gamePassSales: number
  trackedVisits: number
  uniquePlayers: number
  payingPlayers: number
  peakCcu: number
  avgCcu: number | null
  trackedMinutes: number
  sessionsEnded: number
  sessionSecondsTotal: number
  avgSessionSec: number | null
  officialNewVisits: number | null
  days: number
  daysWithData: number
}

export interface DailyRow {
  day: string
  revenue: number
  sales: number
  devProductRevenue: number
  gamePassRevenue: number
  trackedVisits: number
  uniquePlayers: number
  peakCcu: number
  avgCcu: number | null
  avgSessionSec: number | null
  sessionsEnded: number
  officialNewVisits: number | null
  finalized: boolean
}

export interface Summary {
  range: ResolvedRange
  current: Totals
  previous: Totals | null
  daily: DailyRow[]
  firstTrackedAt: number | null
  netRevenueRate: number
  generatedAt: number
}

export interface Insights {
  highestEarningDay: { day: string; revenue: number } | null
  bestSellers: { kind: string; product_id: number; name: string | null; sales: number; revenue: number }[]
  servers7d: { count: number; avgUptimeSec: number | null; heartbeatTimeouts: number }
}
