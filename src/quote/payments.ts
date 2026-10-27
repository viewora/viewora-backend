// Taking a deposit or balance, and confirming it. Three paths confirm a
// payment: the client coming back from Paystack, Paystack's webhook, and a
// check every 10 minutes for payments still waiting. All three call
// confirmPayment(), which asks Paystack itself (never trusting the caller)
// and then settles in one database transaction that runs at most once per
// payment. What follows a settle (invoice, analytics, emails) runs only for
// the call that actually settled it.

import crypto from 'node:crypto'
import type { DeskStore, LinkHit } from './deskStore.js'
import type { QuoteStore } from './store.js'
import type { JobStore } from './jobStore.js'
import { paystackFromEnv, type PaystackClient } from './paystack.js'
import { toSubunits, type JobRecord, type SettleResult } from './jobs.js'
import { alertConfigFromEnv, alertStaff, render, type AlertConfig, type AlertLog } from './alerts.js'
import { issueInvoice } from './invoicing.js'
import { formatKes, inQuietHours, nairobiDate } from './desk.js'
import { quoteRef } from './publicQuote.js'
import { industryLabel } from './industries.js'
import { modules } from './modules/index.js'
import { sendPlainEmail } from '../email/index.js'
import { trackServer } from '../utils/analytics.js'

export const TEMPLATE_DEPOSIT_PAID = 'deposit_paid'
export const TEMPLATE_STAFF_DEPOSIT = 'staff_deposit_paid'
export const TEMPLATE_BALANCE_REQUEST = 'balance_request'
export const REFERENCE = /^qp_[A-Za-z0-9_-]{24}$/

export type ConfirmSource = 'return' | 'webhook' | 'recheck'

export interface PaymentDeps {
  jobs: JobStore
  desk: DeskStore
  store: QuoteStore
  paystack: PaystackClient | null
  alerts: AlertConfig
  log: AlertLog
  publicUrl: string
  messagesLive: boolean
  sendEmail: (msg: { to: string[]; subject: string; text: string }) => Promise<unknown>
  track: (distinctId: string, event: string, props: Record<string, unknown>) => void
  now: () => Date
}

export const newReference = () => `qp_${crypto.randomBytes(18).toString('base64url')}`

const TIER_LABEL: Record<string, string> = { essential: 'Essential', standard: 'Standard', premium: 'Premium', estimate: 'Estimate', draft: 'Custom' }
export const tierLabel = (tier: string | null) => (tier ? TIER_LABEL[tier] ?? tier : '')

export class PaymentsOff extends Error {}

// Opens a Paystack checkout for one option's deposit. Throws DeskError for
// a quote that can't be paid, PaystackError when Paystack can't be reached.
export async function startDeposit(deps: PaymentDeps, hit: LinkHit, input: { tier: string; email: string; token: string }) {
  if (!deps.paystack) throw new PaymentsOff()
  const q = hit.quote
  const option = q.options.find(o => o.tier === input.tier)
  const reference = newReference()
  await deps.jobs.createPayment({
    kind: 'deposit', quoteId: q.id!, tier: input.tier, amount: option?.deposit ?? -1, reference, linkId: hit.linkId,
    email: hit.lead?.email ? null : input.email, live: deps.paystack.live,
  }, nairobiDate(deps.now()))
  return openCheckout(deps, reference, {
    email: input.email, amount: option!.deposit, currency: q.currency,
    callbackUrl: `${deps.publicUrl}/quote/view/${input.token}`,
    metadata: { quote_id: q.id, kind: 'deposit', tier: input.tier },
  }, { tier: input.tier, kind: 'deposit' })
}

// A Paystack link for the balance, for staff to send on WhatsApp
export async function startBalance(deps: PaymentDeps, job: JobRecord, email: string) {
  if (!deps.paystack) throw new PaymentsOff()
  const reference = newReference()
  await deps.jobs.createPayment({ kind: 'balance', quoteId: job.quoteId, jobId: job.id, amount: job.balanceAmount, reference, live: deps.paystack.live }, nairobiDate(deps.now()))
  return openCheckout(deps, reference, {
    email, amount: job.balanceAmount, currency: job.currency,
    callbackUrl: `${deps.publicUrl}/quote/paid`,
    metadata: { quote_id: job.quoteId, job_id: job.id, kind: 'balance' },
  }, { tier: job.tier, kind: 'balance' })
}

async function openCheckout(
  deps: PaymentDeps, reference: string,
  p: { email: string; amount: number; currency: 'KES' | 'USD'; callbackUrl: string; metadata: Record<string, unknown> },
  event: { tier: string | null; kind: 'deposit' | 'balance' },
) {
  try {
    const { authorizationUrl } = await deps.paystack!.initialize({
      email: p.email, amount: toSubunits(p.amount, p.currency), currency: p.currency, reference,
      callbackUrl: p.callbackUrl, channels: ['card', 'mobile_money'], metadata: p.metadata,
    })
    await deps.jobs.setPaymentUrl(reference, authorizationUrl)
    deps.track(`quote:${String(p.metadata.quote_id)}`, event.kind === 'deposit' ? 'deposit started' : 'balance started', { tier: event.tier, live: deps.paystack!.live })
    return { reference, authorizationUrl }
  } catch (e) {
    await deps.jobs.failPayment(reference, 'failed', 'initialize_failed').catch(() => {})
    throw e
  }
}

export type ConfirmStatus = 'paid' | 'pending' | 'failed' | 'unknown' | 'mismatch'

export async function confirmPayment(deps: PaymentDeps, reference: string, source: ConfirmSource): Promise<{ status: ConfirmStatus; kind?: 'deposit' | 'balance'; jobId?: string | null }> {
  const payment = await deps.jobs.payment(reference)
  if (!payment) return { status: 'unknown' }
  if (payment.status === 'success') return { status: 'paid', kind: payment.kind, jobId: payment.jobId }
  if (payment.provider !== 'paystack' || !deps.paystack) return { status: payment.status === 'initialized' ? 'pending' : 'failed', kind: payment.kind }
  if (payment.status !== 'initialized') return { status: 'failed', kind: payment.kind }

  const v = await deps.paystack.verify(reference)
  if (!v || v.status === 'pending') {
    await deps.jobs.paymentChecked(reference)
    // Paystack forgets checkouts nobody finished; stop asking after a day
    if (Date.parse(payment.createdAt) < deps.now().getTime() - 86_400_000) await deps.jobs.failPayment(reference, 'abandoned', 'never_completed')
    return { status: 'pending', kind: payment.kind }
  }
  if (v.status !== 'success') {
    await deps.jobs.failPayment(reference, v.status, v.gatewayResponse?.slice(0, 200) ?? v.status)
    return { status: 'failed', kind: payment.kind }
  }

  const result = await deps.jobs.settle(reference, { amount: v.amount, currency: v.currency, channel: v.channel, paidAt: v.paidAt, raw: v.raw })
  if (result.outcome === 'mismatch') {
    deps.log.error({ reference, expected: payment.amount, paid: v.amount, currency: v.currency }, 'quote: payment amount did not match the quote; nothing booked')
    return { status: 'mismatch', kind: payment.kind }
  }
  if (result.outcome === 'duplicate') {
    deps.log.error({ reference, jobId: result.jobId }, 'quote: money received for a job already paid; refund it')
  }
  if (result.outcome === 'settled') await afterSettle(deps, result, { source, channel: v.channel, tier: payment.tier, amount: payment.amount, live: payment.live })
  return { status: 'paid', kind: payment.kind, jobId: result.jobId }
}

// Never throws: the money is recorded, so a failed email or invoice is
// logged and left on the lead for staff
export async function afterSettle(
  deps: PaymentDeps, result: SettleResult,
  ctx: { source: ConfirmSource | 'manual'; channel: string | null; tier: string | null; amount: number; live: boolean },
) {
  const step = async (name: string, run: () => Promise<unknown>) => {
    try { await run() } catch (e) { deps.log.error({ err: e instanceof Error ? e.message : String(e), jobId: result.jobId }, `quote: after payment, ${name} failed`) }
  }
  if (result.invoiceId && result.jobId) {
    await step('invoice', () => issueInvoice(deps.jobs, deps.log, { invoiceId: result.invoiceId!, jobId: result.jobId!, paymentId: result.paymentId }))
  }
  deps.track(`quote:${result.quoteId}`, result.kind === 'deposit' ? 'deposit paid' : 'balance paid', {
    tier: ctx.tier, via: ctx.source, channel: ctx.channel, live: ctx.live,
  })
  if (result.kind !== 'deposit' || !result.leadId || !result.jobId) return

  const [lead, quote, job] = await Promise.all([deps.desk.lead(result.leadId), deps.desk.quote(result.quoteId), deps.jobs.job(result.jobId)])
  if (!lead || !quote || !job) return
  const ctxReq = await deps.desk.request(quote.requestId)
  const industry = ctxReq ? industryLabel(ctxReq.moduleKey, ctxReq.flags, ctxReq.moduleKey ? modules[ctxReq.moduleKey]?.label : undefined) : ''
  const vars = {
    name: lead.firstName ?? '', amount: formatKes(job.depositAmount, job.currency), balance: formatKes(job.balanceAmount, job.currency),
    option: tierLabel(job.tier), quote_ref: quoteRef(quote.id!, quote.version), industry,
    admin_link: `${deps.alerts.adminUrl}/dashboard/quotes/jobs/${job.id}`,
  }

  await step('staff alert', () => alertStaff(deps.store, deps.alerts, deps.log, {
    leadId: lead.id, quoteId: quote.id, templateKey: TEMPLATE_STAFF_DEPOSIT, what: 'deposit-paid alert', migration: '005', vars,
  }))
  await step('client email', async () => {
    if (!lead.email) return
    const template = await deps.store.messageTemplate(TEMPLATE_DEPOSIT_PAID, 'email')
    const base = { leadId: lead.id, quoteId: quote.id, channel: 'email' as const, templateKey: TEMPLATE_DEPOSIT_PAID }
    if (!template) {
      await deps.store.recordMessage({ ...base, templateVersion: null, renderedBody: null, status: 'failed', error: 'template_missing' })
      return
    }
    const text = render(template.body, vars)
    const message = { ...base, templateVersion: template.version, renderedBody: text }
    const skip = lead.optedOutAt ? 'opted_out' : !deps.messagesLive ? 'sandbox' : inQuietHours(deps.now()) ? 'quiet_hours' : null
    if (skip) {
      await deps.store.recordMessage({ ...message, status: 'skipped', skipReason: skip })
      return
    }
    try {
      await deps.sendEmail({ to: [lead.email], subject: render(template.subject ?? 'Deposit received', vars), text })
      await deps.store.recordMessage({ ...message, status: 'sent', sentAt: deps.now().toISOString() })
    } catch (e) {
      await deps.store.recordMessage({ ...message, status: 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 500) })
    }
  })
}

// The 10-minute check: payments still waiting after the client left
// Paystack (webhook lost, tab closed before the redirect)
export async function recheckPayments(deps: PaymentDeps, limit = 25): Promise<{ checked: number; paid: number }> {
  if (!deps.paystack) return { checked: 0, paid: 0 }
  const refs = await deps.jobs.pendingPayments(5 * 60, 3 * 86_400, limit)
  let paid = 0
  for (const ref of refs) {
    try {
      if ((await confirmPayment(deps, ref, 'recheck')).status === 'paid') paid++
    } catch (e) {
      deps.log.warn({ reference: ref, err: e instanceof Error ? e.message : String(e) }, 'quote: payment recheck failed; will try again')
    }
  }
  return { checked: refs.length, paid }
}

// The client-facing part of a job, shown on the quote page
export function publicJob(job: JobRecord) {
  return {
    ref: job.ref, status: job.status, tier: job.tier, currency: job.currency,
    depositAmount: job.depositAmount, depositPaidAt: job.depositPaidAt,
    balanceAmount: job.balanceAmount, balanceStatus: job.balanceStatus,
    shootDate: job.shootDate, shootWindow: job.shootWindow, shootDateStatus: job.shootDateStatus,
    tourUrl: job.status === 'delivered' || job.status === 'closed' ? job.tourUrl : null,
  }
}

// Wording for the balance request staff send on WhatsApp (click-to-chat)
export async function balanceMessage(deps: Pick<PaymentDeps, 'store'>, vars: { name: string; amount: string; pay_link: string }) {
  const template = await deps.store.messageTemplate(TEMPLATE_BALANCE_REQUEST, 'whatsapp')
  return template ? { text: render(template.body, vars), version: template.version } : null
}

// Production wiring: keys, URLs and sandbox switches from the environment.
// Tests and the dev server pass overrides (a fake Paystack, a fixed clock).
export function paymentDeps(base: Pick<PaymentDeps, 'jobs' | 'desk' | 'store' | 'log'>, overrides: Partial<PaymentDeps> = {}): PaymentDeps {
  return {
    paystack: 'paystack' in overrides ? overrides.paystack! : paystackFromEnv(),
    alerts: alertConfigFromEnv(sendPlainEmail),
    publicUrl: (process.env.QUOTE_PUBLIC_URL ?? 'https://app.viewora.software').replace(/\/$/, ''),
    messagesLive: process.env.QUOTE_MESSAGES_SEND === '1',
    sendEmail: sendPlainEmail,
    track: trackServer,
    now: () => new Date(),
    ...base,
    ...overrides,
  }
}
