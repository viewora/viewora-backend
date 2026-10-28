// Visitors to the quote form, from PostHog: how many people saw the form
// (quote_form_viewed), by source. Read-only, with a personal API key that
// lives only on the server. Without the key the report says "not connected"
// rather than guessing a number.
//
//   QUOTE_POSTHOG_PERSONAL_KEY  a personal API key with query:read only
//   QUOTE_POSTHOG_PROJECT_ID    the project the app sends events to
//   POSTHOG_HOST                default https://us.posthog.com (the app uses the US cloud)

import type { Visitors } from './reports.js'

export type VisitorsFn = (fromIso: string, toIso: string) => Promise<Visitors>

const NOT_CONNECTED: Visitors = { status: 'not_connected', total: null, bySource: {} }

// PostHog's own query language; the dates are ISO strings we built, never user text
export const visitorsQuery = (fromIso: string, toIso: string) => {
  const from = fromIso.replace(/[^0-9TZ:.-]/g, '')
  const to = toIso.replace(/[^0-9TZ:.-]/g, '')
  const where = `event = 'quote_form_viewed' AND timestamp >= toDateTime('${from}') AND timestamp < toDateTime('${to}')`
  // The first row is everyone once; the rest are per source
  return `SELECT '*' AS source, count(DISTINCT person_id) AS visitors FROM events WHERE ${where}
  UNION ALL
  SELECT coalesce(properties.source, 'direct') AS source, count(DISTINCT person_id) AS visitors FROM events WHERE ${where} GROUP BY source`
}

export function posthogVisitors(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): VisitorsFn {
  const key = env.QUOTE_POSTHOG_PERSONAL_KEY
  const project = env.QUOTE_POSTHOG_PROJECT_ID
  const host = (env.POSTHOG_HOST || 'https://us.posthog.com').replace(/\/$/, '')
  if (!key || !project) return async () => NOT_CONNECTED

  return async (fromIso, toIso) => {
    try {
      const res = await fetcher(`${host}/api/projects/${encodeURIComponent(project)}/query/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query: visitorsQuery(fromIso, toIso) } }),
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return { status: 'failed', total: null, bySource: {} }
      const body = await res.json() as { results?: Array<[string | null, number]> }
      const bySource: Record<string, number> = {}
      let total = 0
      for (const [source, n] of body.results ?? []) {
        if (source === '*') total = Number(n)
        else bySource[source || 'direct'] = (bySource[source || 'direct'] ?? 0) + Number(n)
      }
      // A person who came from two sources counts once in each source, once in the total
      return { status: 'ok', total, bySource }
    } catch {
      return { status: 'failed', total: null, bySource: {} }
    }
  }
}
