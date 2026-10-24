// Optional: official usage numbers from the Cloudflare GraphQL Analytics API.
// Needs CF_ACCOUNT_ID (var) and CF_API_TOKEN (secret, "Account Analytics: Read").

export interface CloudflareUsage {
  fetchedAt: number
  day: string
  workerRequests: number | null
  workerErrors: number | null
  doRequests: number | null
  d1RowsRead: number | null
  d1RowsWritten: number | null
  error: string | null
}

const QUERY = `query Usage($account: String!, $start: Time!, $end: Time!, $date: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_lt: $end }) {
        sum { requests errors }
      }
      durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date: $date }) {
        sum { requests }
      }
      d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date: $date }) {
        sum { rowsRead rowsWritten }
      }
    }
  }
}`

type Groups = { sum?: Record<string, number> }[] | undefined

function total(groups: Groups, field: string): number | null {
  if (!Array.isArray(groups)) return null
  return groups.reduce((acc, g) => acc + (g.sum?.[field] ?? 0), 0)
}

export async function fetchCloudflareUsage(accountId: string, token: string, now: number): Promise<CloudflareUsage> {
  const day = new Date(now).toISOString().slice(0, 10)
  const base: CloudflareUsage = {
    fetchedAt: now,
    day,
    workerRequests: null,
    workerErrors: null,
    doRequests: null,
    d1RowsRead: null,
    d1RowsWritten: null,
    error: null,
  }
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        variables: { account: accountId, start: `${day}T00:00:00Z`, end: new Date(now).toISOString(), date: day },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json()) as {
      data?: { viewer?: { accounts?: Record<string, Groups>[] } }
      errors?: { message: string }[] | null
    }
    const acct = body.data?.viewer?.accounts?.[0]
    if (!res.ok || !acct) {
      return { ...base, error: body.errors?.map((e) => e.message).join('; ') || `GraphQL request failed (${res.status})` }
    }
    return {
      ...base,
      workerRequests: total(acct.workersInvocationsAdaptive, 'requests'),
      workerErrors: total(acct.workersInvocationsAdaptive, 'errors'),
      doRequests: total(acct.durableObjectsInvocationsAdaptiveGroups, 'requests'),
      d1RowsRead: total(acct.d1AnalyticsAdaptiveGroups, 'rowsRead'),
      d1RowsWritten: total(acct.d1AnalyticsAdaptiveGroups, 'rowsWritten'),
      error: body.errors?.length ? body.errors.map((e) => e.message).join('; ') : null,
    }
  } catch (err) {
    return { ...base, error: (err as Error).message }
  }
}
