// Quote engine reports (Phase 5a). The database returns one row per form
// started in the period (reportStore); everything here is plain arithmetic
// on those rows, so it is the same in tests, locally and in production.
//
// Definitions, as the admin shows them:
//   started     picked an industry (step 1 saved)
//   completed   reached the price
//   quoted      a quote was sent (by staff or the automatic quote link)
//   booked      a job exists and was not cancelled (the deposit was paid)
//   paid        the job's balance is paid
//   win rate    booked ÷ quoted
//   job value   the booked option's price before VAT
//   first staff action  minutes from a finished form to the first thing
//               staff did on the lead (sent a message, edited or sent a quote,
//               moved the lead, added a note)

export interface ReportRow {
  requestId: string
  startedAt: string
  industry: string                 // the tile they picked: a planned hint, else the module
  source: string | null
  stepReached: number
  completed: boolean
  quoted: boolean
  booked: boolean
  paid: boolean
  jobValue: number | null          // before VAT, in the job currency
  currency: 'KES' | 'USD' | null
  firstStaffMinutes: number | null
  abVariant: string | null         // the contact-step A/B test (Phase 5c)
}

export interface Visitors {
  status: 'ok' | 'not_connected' | 'failed' | 'not_by_industry'
  total: number | null
  bySource: Record<string, number>
}

export const STEP_COUNT = 5

export interface FunnelStep { key: 'visitors' | 'started' | 'completed' | 'quoted' | 'booked' | 'paid'; count: number | null; ofPrevious: number | null }

export interface GroupRow {
  key: string
  started: number
  completed: number
  quoted: number
  booked: number
  winRate: number | null          // basis points
  avgJobValue: number | null      // KES only: USD jobs are counted, not averaged in
}

export interface Report {
  funnel: FunnelStep[]
  // Unfinished forms by the last step they saved: "left after step N"
  dropOff: Array<{ step: number; count: number }>
  byIndustry: GroupRow[]
  bySource: GroupRow[]
  // Only forms that were in the test; empty while it is off
  byVariant: GroupRow[]
  kpis: {
    completed: number
    quoted: number
    booked: number
    winRate: number | null
    avgJobValue: number | null
    medianFirstStaffMinutes: number | null
    usdJobs: number
  }
}

const bp = (part: number, whole: number) => (whole ? Math.round((part * 10_000) / whole) : null)

function median(values: number[]): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

function avgKes(rows: ReportRow[]): number | null {
  const values = rows.filter(r => r.booked && r.currency === 'KES' && r.jobValue !== null).map(r => r.jobValue!)
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null
}

function group(rows: ReportRow[], keyOf: (r: ReportRow) => string): GroupRow[] {
  const by = new Map<string, ReportRow[]>()
  for (const r of rows) by.set(keyOf(r), [...(by.get(keyOf(r)) ?? []), r])
  return [...by].map(([key, rs]) => {
    const quoted = rs.filter(r => r.quoted).length
    const booked = rs.filter(r => r.booked).length
    return {
      key, started: rs.length, completed: rs.filter(r => r.completed).length, quoted, booked,
      winRate: bp(booked, quoted), avgJobValue: avgKes(rs),
    }
  }).sort((a, b) => b.started - a.started || a.key.localeCompare(b.key))
}

export function buildReport(rows: ReportRow[], visitors: Visitors): Report {
  const count = (f: (r: ReportRow) => boolean) => rows.filter(f).length
  const counts = {
    visitors: visitors.status === 'ok' ? visitors.total : null,
    started: rows.length,
    completed: count(r => r.completed),
    quoted: count(r => r.quoted),
    booked: count(r => r.booked),
    paid: count(r => r.paid),
  }
  const keys = ['visitors', 'started', 'completed', 'quoted', 'booked', 'paid'] as const
  const funnel = keys.map((key, i): FunnelStep => {
    const n = counts[key]
    const prev = i ? counts[keys[i - 1]] : null
    return { key, count: n, ofPrevious: n !== null && prev ? bp(n, prev) : null }
  })
  const unfinished = rows.filter(r => !r.completed)
  const dropOff = Array.from({ length: STEP_COUNT }, (_, i) => ({ step: i + 1, count: unfinished.filter(r => Math.min(r.stepReached, STEP_COUNT) === i + 1).length }))
  return {
    funnel,
    dropOff,
    byIndustry: group(rows, r => r.industry),
    bySource: group(rows, r => r.source ?? 'direct'),
    byVariant: group(rows.filter(r => r.abVariant), r => r.abVariant!),
    kpis: {
      completed: counts.completed,
      quoted: counts.quoted,
      booked: counts.booked,
      winRate: bp(counts.booked, counts.quoted),
      avgJobValue: avgKes(rows),
      medianFirstStaffMinutes: median(rows.map(r => r.firstStaffMinutes).filter((m): m is number => m !== null)),
      usdJobs: count(r => r.booked && r.currency === 'USD'),
    },
  }
}

// ── Periods: Nairobi calendar days ────────────────────────────────────────
// A day in Nairobi starts at 21:00 UTC the day before (EAT is UTC+3, no DST)
export function nairobiRange(from: string, to: string): { fromIso: string; toIso: string } {
  const start = new Date(`${from}T00:00:00+03:00`)
  const end = new Date(`${to}T00:00:00+03:00`)
  end.setUTCDate(end.getUTCDate() + 1)            // "to" is inclusive
  return { fromIso: start.toISOString(), toIso: end.toISOString() }
}

export function reportCsv(report: Report): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const pct = (b: number | null) => (b === null ? '' : `${b / 100}%`)
  const lines = [['Group', 'Name', 'Started', 'Completed', 'Quoted', 'Booked', 'Win rate', 'Average job value (KES, before VAT)'].join(',')]
  for (const [label, rows] of [['Industry', report.byIndustry], ['Source', report.bySource], ['Contact test', report.byVariant]] as const) {
    for (const r of rows) lines.push([label, r.key, r.started, r.completed, r.quoted, r.booked, pct(r.winRate), r.avgJobValue].map(cell).join(','))
  }
  return lines.join('\n') + '\n'
}
