import type { ResolvedRange } from '@shared/time'

export interface CcuSeries {
  window: string
  bucketMs: number
  points: { t: number; ccu: number; max: number; servers: number; official: number | null }[]
  firstTrackedAt: number | null
  live: { t: number; ccu: number }
}

export interface RevenueSeries {
  granularity: 'hour' | 'day'
  range: ResolvedRange
  buckets: { t: number; day?: string; revenue: number; sales: number; devProductRevenue: number; gamePassRevenue: number }[]
  firstTrackedAt: number | null
}

export interface VisitsSeries {
  granularity: 'hour' | 'day'
  range: ResolvedRange
  buckets: { t: number; day?: string; tracked: number; official: number | null; uniquePlayers?: number }[]
  firstTrackedAt: number | null
}

export interface ProductsResponse {
  products: { kind: string; productId: number; name: string | null; revenue: number; sales: number; buyers: number; lastSoldAt: number }[]
}
