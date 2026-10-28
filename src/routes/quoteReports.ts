// Reports (under /admin/quote). The staff check runs in quoteAdmin.ts first.
//
//   GET /reports        funnel, drop-off by step, industries, sources, first
//                       staff action; ?from=&to= (Nairobi dates), ?industry=, ?source=
//   GET /reports.csv    the industry and source tables as a spreadsheet
//
// Counts only: no names, numbers or messages leave this route. Partner
// referrals and commission are added for staff who can see commission.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { allowed, PERMISSIONS } from '../quote/staffAuth.js'
import type { LinkStore } from '../quote/linkStore.js'
import type { ReportStore } from '../quote/reportStore.js'
import type { VisitorsFn } from '../quote/posthogVisitors.js'
import { commissionFor } from '../quote/links.js'
import { nairobiDate } from '../quote/desk.js'
import { buildReport, nairobiRange, reportCsv, type Visitors } from '../quote/reports.js'

const MAX_DAYS = 400
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Not a date')

const reportQuery = z.object({
  from: date.optional(),
  to: date.optional(),
  industry: z.string().trim().regex(/^[a-z_]{1,40}$/).optional(),
  source: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,40}$/).optional(),
})

export default async function quoteReportRoutes(fastify: FastifyInstance, opts: {
  reports: ReportStore; visitors: VisitorsFn; links: LinkStore; now: () => Date
}) {
  const { reports, visitors, links, now } = opts

  async function build(request: FastifyRequest, q: z.infer<typeof reportQuery>) {
    const to = q.to ?? nairobiDate(now())
    const from = q.from ?? nairobiDate(new Date(`${to}T12:00:00+03:00`), -29)
    const { fromIso, toIso } = nairobiRange(from, to)
    const all = await reports.rows(fromIso, toIso)
    const rows = all.filter(r => (!q.industry || r.industry === q.industry) && (!q.source || (r.source ?? 'direct') === q.source))

    // PostHog does not know which tile a visitor would have picked
    let seen: Visitors
    if (q.industry) seen = { status: 'not_by_industry', total: null, bySource: {} }
    else {
      seen = await visitors(fromIso, toIso)
      if (seen.status === 'ok' && q.source) seen = { ...seen, total: seen.bySource[q.source] ?? 0 }
    }

    // Filter choices come from the whole period, so picking one never hides the others
    const choices = {
      industries: [...new Set(all.map(r => r.industry))].sort(),
      sources: [...new Set(all.map(r => r.source ?? 'direct'))].sort(),
    }
    const report = buildReport(rows, seen)
    const staffRole = request.quoteStaff!.role
    const partners = PERMISSIONS['commission:read'].includes(staffRole) ? await partnerSummary() : null
    return { from, to, filter: { industry: q.industry ?? null, source: q.source ?? null }, choices, visitors: seen, ...report, partners }
  }

  // All-time per partner: leads referred, jobs, and commission by currency
  async function partnerSummary() {
    const [partners, jobs] = await Promise.all([links.partners(), links.commissionJobs({})])
    const rows = jobs.map(commissionFor)
    return partners.map(p => {
      const mine = rows.filter(r => r.partnerId === p.id)
      const money: Record<string, { owed: number; paid: number }> = {}
      for (const r of mine) {
        const m = (money[r.currency] ??= { owed: 0, paid: 0 })
        if (r.commissionStatus === 'owed') m.owed += r.commission ?? 0
        if (r.commissionStatus === 'paid') m.paid += r.commission ?? 0
      }
      return {
        id: p.id, name: p.name, code: p.code, active: p.active, leads: p.leads,
        jobs: mine.filter(r => r.status !== 'cancelled').length, commission: money,
      }
    }).sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name))
  }

  const parse = (request: FastifyRequest, reply: Parameters<typeof parseWithSchema>[0]) => {
    const q = parseWithSchema(reply, reportQuery, request.query)
    if (!q) return null
    const to = q.to ?? nairobiDate(now())
    if (q.from && q.from > to) {
      reply.code(400).send({ code: 'BAD_RANGE', statusMessage: 'The start date is after the end date.' })
      return null
    }
    if (q.from && (Date.parse(to) - Date.parse(q.from)) / 86_400_000 > MAX_DAYS) {
      reply.code(400).send({ code: 'BAD_RANGE', statusMessage: `Pick ${MAX_DAYS} days or fewer.` })
      return null
    }
    return q
  }

  fastify.get('/reports', async (request, reply) => {
    if (!allowed(request, reply, 'reports:read')) return
    const q = parse(request, reply)
    if (!q) return
    return build(request, q)
  })

  fastify.get('/reports.csv', async (request, reply) => {
    if (!allowed(request, reply, 'reports:read')) return
    const q = parse(request, reply)
    if (!q) return
    const r = await build(request, q)
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="quote-report-${r.from}-to-${r.to}.csv"`)
    return reportCsv(r)
  })
}
