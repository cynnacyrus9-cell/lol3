import type { UsageCounters } from './usage'

/**
 * Thin D1 wrapper that records exact rows read/written (from D1 result metadata)
 * so the admin panel can show real free-tier consumption.
 */
export class Db {
  constructor(
    private readonly d1: D1Database,
    private readonly usage: () => UsageCounters,
  ) {}

  prepare(sql: string, ...params: unknown[]): D1PreparedStatement {
    const stmt = this.d1.prepare(sql)
    return params.length ? stmt.bind(...params) : stmt
  }

  private track(meta: D1Result['meta'] | undefined): void {
    const u = this.usage()
    u.d1.queries += 1
    u.d1.rowsRead += meta?.rows_read ?? 0
    u.d1.rowsWritten += meta?.rows_written ?? 0
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const res = await this.prepare(sql, ...params).all<T>()
    this.track(res.meta)
    return res.results ?? []
  }

  async first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null> {
    const res = await this.prepare(sql, ...params).all<T>()
    this.track(res.meta)
    return res.results?.[0] ?? null
  }

  async run(sql: string, ...params: unknown[]): Promise<D1Result> {
    const res = await this.prepare(sql, ...params).run()
    this.track(res.meta)
    return res
  }

  /** Executes statements atomically (D1 batches run as a single transaction). */
  async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    if (stmts.length === 0) return []
    const res = await this.d1.batch(stmts)
    for (const r of res) this.track(r.meta)
    return res
  }
}

/** SQL fragment selecting rows that count as real statistics for the current mode. */
export function sourceFilter(mode: 'production' | 'development', column = 'source'): string {
  // Constant strings only — never user input.
  return mode === 'development' ? `${column} IN ('live','synthetic')` : `${column} = 'live'`
}
