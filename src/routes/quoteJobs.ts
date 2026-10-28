// Jobs (under /admin/quote): what a paid deposit becomes. Staff confirm the
// shoot day, assign a photographer, log hours and costs, deliver the tour
// and collect the balance. The staff check runs in quoteAdmin.ts first.
//
//   GET    /jobs                   list with filters
//   GET    /jobs/:id               one job, with costs, payments and profit
//   PATCH  /jobs/:id               schedule, staff, status, hours, delivery
//   POST   /jobs/:id/costs         add a direct cost;  DELETE /jobs/:id/costs/:costId
//   POST   /jobs/:id/balance       record a balance paid outside Paystack (admin)
//   POST   /jobs/:id/balance-link  a Paystack link for the balance, to send on WhatsApp
//   GET    /jobs-export            the profitability tracker as CSV (admin)
//   GET    /booking-settings       PUT /booking-settings (admin)

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { sanitizeLeadText } from '../utils/sanitize.js'
import { DeskError, type DeskStore } from '../quote/deskStore.js'
import type { QuoteStore } from '../quote/store.js'
import type { JobStore } from '../quote/jobStore.js'
import { allowed } from '../quote/staffAuth.js'
import { JOB_STATUSES, WINDOWS, profit, trackerCsv, type JobRecord } from '../quote/jobs.js'
import { PaystackError } from '../quote/paystack.js'
import { PaymentsOff, TEMPLATE_BALANCE_REQUEST, afterSettle, balanceMessage, startBalance, type PaymentDeps } from '../quote/payments.js'
import { formatKes, inQuietHours, nairobiDate } from '../quote/desk.js'
import { CLIENT_TYPE_LABELS, industryLabel } from '../quote/industries.js'
import type { FollowupStore } from '../quote/followupStore.js'
import { jobDelivered } from '../quote/messaging.js'

const MESSAGES: Record<string, string> = {
  not_found: 'That job no longer exists.',
  owner_not_staff: 'Pick an active staff member.',
  balance_closed: 'The balance is already settled for this job.',
  amount_mismatch: 'The balance changed. Refresh the page and try again.',
  date_locked: 'The shoot day is confirmed. Change it here instead.',
  slot_full: 'That slot is full.',
  payments_off: 'Paystack is not set up for quotes (QUOTE_PAYSTACK_SECRET_KEY). Record the payment by hand instead.',
}
const fail = (reply: FastifyReply, code: string, status = 409) =>
  reply.code(status).send({ code: code.toUpperCase(), statusMessage: MESSAGES[code] ?? 'That change is not possible right now.' })

async function guard<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof DeskError) { fail(reply, e.code, e.code === 'not_found' ? 404 : 409); return undefined }
    throw e
  }
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const idParams = z.object({ id: z.string().uuid() })
const costParams = z.object({ id: z.string().uuid(), costId: z.string().uuid() })
const hoursValue = z.number().min(0).max(200).multipleOf(0.25)
const listQuery = z.object({
  status: z.enum([...JOB_STATUSES, 'open']).optional(),
  staffId: z.string().uuid().optional(),
  from: date.optional(),
  to: date.optional(),
  leadId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
const patchBody = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  shootDate: date.nullable().optional(),
  shootWindow: z.enum(WINDOWS).nullable().optional(),
  shootDateStatus: z.enum(['none', 'requested', 'confirmed']).optional(),
  assignedStaffId: z.string().uuid().nullable().optional(),
  hours: z.object({ travel: hoursValue, shoot: hoursValue, edit: hoursValue, admin: hoursValue }).partial().optional(),
  deliveredAt: z.string().datetime().nullable().optional(),
  tourUrl: z.string().trim().url().max(500).refine(u => /^https:\/\//.test(u), 'https only').nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
}).strict().refine(p => Object.keys(p).length > 0, 'nothing to change')
const costBody = z.object({ label: z.string().trim().min(1).max(80), amount: z.number().int().min(1).max(10_000_000) })
const manualBody = z.object({
  channel: z.enum(['mpesa', 'cash', 'bank']),
  reference: z.string().trim().max(40).regex(/^[A-Za-z0-9 _./-]*$/).default(''),
  note: z.string().trim().max(300).default(''),
})
const exportQuery = z.object({ status: z.enum([...JOB_STATUSES, 'open']).optional(), from: date.optional(), to: date.optional() })
const settingsBody = z.object({
  perSlot: z.number().int().min(1).max(20),
  windows: z.array(z.enum(WINDOWS)).min(1).max(2),
  daysOff: z.array(z.number().int().min(0).max(6)).max(6),
  noticeDays: z.number().int().min(0).max(30),
  horizonDays: z.number().int().min(7).max(180),
}).refine(s => s.horizonDays > s.noticeDays, 'the last bookable day must come after the first')

const withProfit = (j: JobRecord) => ({ ...j, profit: profit(j) })
const labels = {
  industry: (key: string | null) => industryLabel(key, []),
  clientType: (key: string | null) => (key ? CLIENT_TYPE_LABELS[key] ?? key : ''),
}

export interface JobRouteOptions {
  desk: DeskStore
  store: QuoteStore
  jobs: JobStore
  payments: PaymentDeps
  followups?: FollowupStore              // delivering a job starts the review and renewal follow-ups
}

export default async function quoteJobsRoutes(fastify: FastifyInstance, opts: JobRouteOptions) {
  const { desk, store, jobs, payments } = opts
  const now = payments.now

  fastify.get('/jobs', async (request, reply) => {
    if (!allowed(request, reply, 'jobs:read')) return
    const query = parseWithSchema(reply, listQuery, request.query)
    if (!query) return
    const { page, limit, ...filter } = query
    const result = await jobs.jobs({ ...filter, status: filter.status as any, q: filter.q || undefined, limit, offset: (page - 1) * limit })
    return { total: result.total, rows: result.rows.map(withProfit), page, limit }
  })

  const loadJob = async (reply: FastifyReply, params: unknown) => {
    const p = parseWithSchema(reply, idParams, params)
    if (!p) return null
    const job = await jobs.job(p.id)
    if (!job) { fail(reply, 'not_found', 404); return null }
    return job
  }

  fastify.get('/jobs/:id', async (request, reply) => {
    if (!allowed(request, reply, 'jobs:read')) return
    const job = await loadJob(reply, request.params)
    if (!job) return
    const lead = await desk.lead(job.leadId)
    fastify.log.info({ staffId: request.quoteStaff!.id, jobId: job.id }, 'quote admin: job viewed')
    // Others booked on the same day, so staff can see a clash before confirming
    const sameDay = job.shootDate ? (await jobs.jobs({ from: job.shootDate, to: job.shootDate, limit: 20 })).rows.filter(j => j.id !== job.id && j.status !== 'cancelled') : []
    return {
      job: withProfit(job),
      lead: lead && { id: lead.id, firstName: lead.firstName, whatsappE164: lead.whatsappE164, email: lead.email, optedOut: !!lead.optedOutAt, stage: lead.stage },
      sameDay: sameDay.map(j => ({ id: j.id, ref: j.ref, leadName: j.leadName, shootWindow: j.shootWindow, shootDateStatus: j.shootDateStatus })),
      paymentsOn: !!payments.paystack,
    }
  })

  fastify.patch('/jobs/:id', async (request, reply) => {
    if (!allowed(request, reply, 'jobs:write')) return
    const params = parseWithSchema(reply, idParams, request.params)
    const body = params && parseWithSchema(reply, patchBody, request.body)
    if (!params || !body) return
    const patch = { ...body, notes: body.notes === undefined ? undefined : body.notes === null ? null : sanitizeLeadText(body.notes, 2000).trim() || null }
    if (patch.notes === undefined) delete patch.notes
    // Confirming needs a day and a slot
    if (patch.shootDateStatus === 'confirmed') {
      const current = await jobs.job(params.id)
      const day = patch.shootDate !== undefined ? patch.shootDate : current?.shootDate
      const slot = patch.shootWindow !== undefined ? patch.shootWindow : current?.shootWindow
      if (!day || !slot) return reply.code(422).send({ code: 'NO_DATE', statusMessage: 'Pick a day and morning or afternoon before confirming.' })
    }
    const before = patch.status === 'delivered' ? await jobs.job(params.id) : null
    const job = await guard(reply, () => jobs.updateJob(params.id, patch as any, request.quoteStaff!.id))
    if (job && opts.followups && before && before.status !== 'delivered') {
      await jobDelivered({ followups: opts.followups, now }, job.leadId, job.id)
        .catch(err => fastify.log.error({ err: err instanceof Error ? err.message : String(err), jobId: job.id }, 'quote jobs: could not start follow-ups'))
    }
    return job && { job: withProfit(job) }
  })

  fastify.post('/jobs/:id/costs', async (request, reply) => {
    if (!allowed(request, reply, 'jobs:write')) return
    const params = parseWithSchema(reply, idParams, request.params)
    const body = params && parseWithSchema(reply, costBody, request.body)
    if (!params || !body) return
    const label = sanitizeLeadText(body.label, 80).trim()
    if (!label) return reply.code(422).send({ code: 'NO_LABEL', statusMessage: 'Say what the cost was for.' })
    const cost = await guard(reply, () => jobs.addCost(params.id, label, body.amount, request.quoteStaff!.id))
    return cost && { cost }
  })

  fastify.delete('/jobs/:id/costs/:costId', async (request, reply) => {
    if (!allowed(request, reply, 'jobs:write')) return
    const params = parseWithSchema(reply, costParams, request.params)
    if (!params) return
    const ok = await guard(reply, async () => { await jobs.deleteCost(params.id, params.costId, request.quoteStaff!.id); return true })
    if (ok) return reply.code(204).send()
  })

  fastify.post('/jobs/:id/balance', async (request, reply) => {
    if (!allowed(request, reply, 'payments:write')) return
    const params = parseWithSchema(reply, idParams, request.params)
    const body = params && parseWithSchema(reply, manualBody, request.body)
    if (!params || !body) return
    const me = request.quoteStaff!
    const result = await guard(reply, () => jobs.manualBalance(params.id, me.id, body.channel, body.reference, sanitizeLeadText(body.note, 300).trim()))
    if (!result) return
    const job = (await jobs.job(params.id))!
    await afterSettle(payments, result, { source: 'manual', channel: body.channel, tier: job.tier, amount: job.balanceAmount, live: false })
    return { job: withProfit(job) }
  })

  fastify.post('/jobs/:id/balance-link', async (request, reply) => {
    if (!allowed(request, reply, 'jobs:write')) return
    const job = await loadJob(reply, request.params)
    if (!job) return
    if (job.balanceStatus !== 'pending') return fail(reply, 'balance_closed')
    const lead = await desk.lead(job.leadId)
    if (!lead) return fail(reply, 'not_found', 404)
    if (lead.optedOutAt) return reply.code(409).send({ code: 'OPTED_OUT', statusMessage: 'This client asked not to be contacted. Collect the balance in person.' })
    if (!lead.email) return reply.code(409).send({ code: 'NO_EMAIL', statusMessage: 'Paystack needs the client\'s email. Add it to the lead, or record the payment by hand.' })
    if (inQuietHours(now())) {
      return reply.code(409).send({ code: 'QUIET_HOURS', statusMessage: 'We only message clients between 07:00 and 21:00 Nairobi time. Try again after 07:00.' })
    }
    let link: { authorizationUrl: string; reference: string }
    try {
      link = await startBalance(payments, job, lead.email)
    } catch (e) {
      if (e instanceof DeskError) return fail(reply, e.code)
      if (e instanceof PaymentsOff) return fail(reply, 'payments_off')
      if (e instanceof PaystackError) {
        fastify.log.error({ err: e.message, jobId: job.id }, 'quote jobs: balance link did not open')
        return reply.code(502).send({ code: 'PROVIDER_DOWN', statusMessage: 'Paystack did not answer. Try again in a minute.' })
      }
      throw e
    }
    const message = await balanceMessage(payments, { name: lead.firstName ?? '', amount: formatKes(job.balanceAmount, job.currency), pay_link: link.authorizationUrl })
    if (!message) return reply.code(409).send({ code: 'TEMPLATE_MISSING', statusMessage: `The "${TEMPLATE_BALANCE_REQUEST}" WhatsApp wording is missing. Run migration 005.` })
    const waUrl = lead.whatsappE164 ? `https://wa.me/${lead.whatsappE164.replace(/\D/g, '')}?text=${encodeURIComponent(message.text)}` : null
    // Click-to-chat: the staff member presses send on their own WhatsApp
    await store.recordMessage({
      leadId: lead.id, quoteId: job.quoteId, channel: 'whatsapp', templateKey: TEMPLATE_BALANCE_REQUEST, templateVersion: message.version,
      renderedBody: message.text, status: 'sent', skipReason: 'click_to_chat', sentAt: now().toISOString(),
    })
    return { url: link.authorizationUrl, waUrl, live: payments.paystack!.live }
  })

  fastify.get('/jobs-export', async (request, reply) => {
    if (!allowed(request, reply, 'jobs:export')) return
    const query = parseWithSchema(reply, exportQuery, request.query)
    if (!query) return
    const rows: JobRecord[] = []
    for (let offset = 0; ; offset += 100) {
      const page = await jobs.jobs({ ...query, status: query.status as any, limit: 100, offset })
      rows.push(...page.rows)
      if (rows.length >= page.total || !page.rows.length || offset > 20_000) break
    }
    fastify.log.info({ staffId: request.quoteStaff!.id, rows: rows.length }, 'quote admin: tracker exported')
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="viewora-jobs-${nairobiDate(now())}.csv"`)
    reply.header('Cache-Control', 'no-store')
    return trackerCsv(rows, labels)
  })

  fastify.get('/booking-settings', async (request, reply) => {
    if (!allowed(request, reply, 'jobs:read')) return
    return { settings: await jobs.bookingSettings() }
  })

  fastify.put('/booking-settings', async (request, reply) => {
    if (!allowed(request, reply, 'settings:write')) return
    const body = parseWithSchema(reply, settingsBody, request.body)
    if (!body) return
    const value = { ...body, windows: [...new Set(body.windows)], daysOff: [...new Set(body.daysOff)].sort() } as any
    await jobs.setBookingSettings(value, request.quoteStaff!.id)
    return { settings: value }
  })
}
