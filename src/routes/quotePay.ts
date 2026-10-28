// Paying and booking from the client's quote link (under /quote):
//   POST /view/:token/pay       open a Paystack checkout for one option's deposit
//   POST /payments/verify       the client is back from Paystack: ask Paystack and settle
//   GET  /view/:token/booking   open days for the shoot, once the deposit is paid
//   POST /view/:token/date      the client asks for a day and morning or afternoon
//   POST /payments/webhook      Paystack's webhook (test mode URL for now)
// Amounts always come from the stored quote, never from the browser.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { DeskError, type DeskStore } from '../quote/deskStore.js'
import type { JobStore } from '../quote/jobStore.js'
import { publicQuote } from '../quote/publicQuote.js'
import { DEFAULT_BOOKING, WINDOWS, bookingDays, payBlocker, slotOpen, usdPaymentsOn } from '../quote/jobs.js'
import { PaystackError, signatureValid } from '../quote/paystack.js'
import {
  PaymentsOff, REFERENCE, confirmPayment, publicJob, startDeposit, type PaymentDeps,
} from '../quote/payments.js'
import { nairobiDate } from '../quote/desk.js'
import { findHit, limit } from './quotePublic.js'

const MESSAGES: Record<string, string> = {
  not_payable: 'This quote is no longer open for payment. Refresh the page to see where it stands.',
  already_booked: 'This quote is already paid and booked. Refresh the page to see your booking.',
  not_open: 'This quote is no longer open for payment. Ask us for a new one.',
  expired: 'This price has expired. Ask us on WhatsApp for an updated quote.',
  not_final: 'We need to confirm the final price before you can pay. We will send it on WhatsApp.',
  no_deposit: 'This quote has no deposit to pay. WhatsApp us to book.',
  no_option: 'That option has changed. Refresh the page and try again.',
  amount_mismatch: 'That option has changed. Refresh the page and try again.',
  payments_off: 'Paying online is not open yet. WhatsApp us and we will book you in.',
  usd_by_link: 'Your quote is in US dollars. We will send you a payment link on WhatsApp.',
  slot_full: 'Someone has just taken that slot. Pick another day or time.',
  date_locked: 'Your shoot day is already confirmed. WhatsApp us if you need to change it.',
  no_job: 'Pay the deposit first, then pick your shoot day.',
  not_found: 'We could not find that payment.',
}

const fail = (reply: FastifyReply, code: string, status = 409) =>
  reply.code(status).send({ code: code.toUpperCase(), statusMessage: MESSAGES[code] ?? 'That is not possible right now. Refresh the page and try again.' })

const payBody = z.object({
  tier: z.enum(['essential', 'standard', 'premium', 'estimate', 'draft']),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
})
const verifyBody = z.object({ reference: z.string().regex(REFERENCE) })
const dateBody = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), window: z.enum(WINDOWS) })

export interface PayRouteOptions {
  desk: DeskStore
  jobs: JobStore
  payments: PaymentDeps
  webhookSecret: string | null       // QUOTE_PAYSTACK_SECRET_KEY: Paystack signs webhooks with the secret key
}

export default async function quotePayRoutes(fastify: FastifyInstance, opts: PayRouteOptions) {
  const { desk, jobs, payments } = opts
  const now = payments.now

  fastify.post('/view/:token/pay', { config: limit(10) }, async (request, reply) => {
    const found = await findHit(desk, reply, request.params)
    const body = found && parseWithSchema(reply, payBody, request.body)
    if (!found || !body) return
    const { hit, token } = found
    const view = publicQuote(hit, now())
    const job = await jobs.jobForRequest(hit.quote.requestId)
    const blocker = payBlocker(hit.quote, view.state, { hasJob: !!job, paymentsOn: !!payments.paystack, usdPayments: usdPaymentsOn() })
    if (blocker) return fail(reply, blocker)
    const email = hit.lead?.email ?? body.email
    if (!email) return reply.code(422).send({ code: 'EMAIL_NEEDED', statusMessage: 'Add your email address. Paystack sends your receipt there.' })
    try {
      const { authorizationUrl, reference } = await startDeposit(payments, hit, { tier: body.tier, email, token })
      reply.header('Cache-Control', 'no-store')
      return { authorizationUrl, reference }
    } catch (e) {
      if (e instanceof DeskError) return fail(reply, e.code, e.code === 'not_found' ? 404 : 409)
      if (e instanceof PaymentsOff) return fail(reply, 'payments_off')
      if (e instanceof PaystackError) {
        fastify.log.error({ err: e.message, quoteId: hit.quote.id }, 'quote pay: Paystack checkout did not open')
        return reply.code(502).send({ code: 'PROVIDER_DOWN', statusMessage: 'We could not reach Paystack. Nothing was charged. Try again in a minute, or WhatsApp us.' })
      }
      throw e
    }
  })

  // The reference is random and unguessable; the answer says only whether it is paid
  fastify.post('/payments/verify', { config: limit(30) }, async (request, reply) => {
    const body = parseWithSchema(reply, verifyBody, request.body)
    if (!body) return
    try {
      const r = await confirmPayment(payments, body.reference, 'return')
      if (r.status === 'unknown') return fail(reply, 'not_found', 404)
      reply.header('Cache-Control', 'no-store')
      return { status: r.status, kind: r.kind }
    } catch (e) {
      fastify.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'quote pay: verify failed; the 10-minute check will retry')
      return { status: 'pending' }
    }
  })

  const settings = async () => ({ ...DEFAULT_BOOKING, ...(await jobs.bookingSettings()) })
  const daysFor = async (jobId: string) => {
    const s = await settings()
    const from = nairobiDate(now(), s.noticeDays)
    const to = nairobiDate(now(), s.horizonDays)
    // The client's own request doesn't count against them
    const own = await jobs.job(jobId)
    const taken = (await jobs.bookingCounts(from, to)).map(c =>
      own && c.date === own.shootDate && c.window === own.shootWindow ? { ...c, n: c.n - 1 } : c)
    return { settings: s, days: bookingDays(s, taken, now()) }
  }

  fastify.get('/view/:token/booking', { config: limit(60) }, async (request, reply) => {
    const found = await findHit(desk, reply, request.params)
    if (!found) return
    const job = await jobs.jobForRequest(found.hit.quote.requestId)
    if (!job) return fail(reply, 'no_job', 404)
    const { settings: s, days } = await daysFor(job.id)
    reply.header('Cache-Control', 'no-store')
    return { job: publicJob(job), windows: s.windows, days }
  })

  fastify.post('/view/:token/date', { config: limit(10) }, async (request, reply) => {
    const found = await findHit(desk, reply, request.params)
    const body = found && parseWithSchema(reply, dateBody, request.body)
    if (!found || !body) return
    const job = await jobs.jobForRequest(found.hit.quote.requestId)
    if (!job) return fail(reply, 'no_job', 404)
    if (job.shootDateStatus === 'confirmed') return fail(reply, 'date_locked')
    const { settings: s, days } = await daysFor(job.id)
    const window = body.window as typeof WINDOWS[number]
    if (!slotOpen(days, body.date, window)) return fail(reply, 'slot_full')
    try {
      const updated = await jobs.requestDate(job.id, body.date, window, s.perSlot)
      return { job: publicJob(updated) }
    } catch (e) {
      if (e instanceof DeskError) return fail(reply, e.code)
      throw e
    }
  })

  // Webhook: its own JSON parser keeps the raw body for the signature check
  await fastify.register(async hook => {
    hook.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1_000_000 }, (_req, body, done) => done(null, body))
    hook.post('/payments/webhook', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request, reply) => {
      const raw = typeof request.body === 'string' ? request.body : ''
      if (!opts.webhookSecret || !signatureValid(raw, request.headers['x-paystack-signature'] as string | undefined, opts.webhookSecret)) {
        return reply.code(401).send({ code: 'BAD_SIGNATURE' })
      }
      let event: any
      try { event = JSON.parse(raw) } catch { return reply.code(400).send({ code: 'BAD_JSON' }) }
      const reference = event?.data?.reference
      // Answer at once (Paystack retries slow webhooks); the work is idempotent
      reply.code(200).send({ received: true })
      if (event?.event !== 'charge.success' || typeof reference !== 'string' || !REFERENCE.test(reference)) return reply
      await confirmPayment(payments, reference, 'webhook').catch(e =>
        fastify.log.error({ reference, err: e instanceof Error ? e.message : String(e) }, 'quote webhook: confirm failed; the 10-minute check will retry'))
      return reply
    })
  })
}
