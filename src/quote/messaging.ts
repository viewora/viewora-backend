// Every client message goes through sendMessage(channel, template, lead):
// it renders the editable wording, checks opt-out and consent, and hands
// the text to a provider. Email goes through Resend (sandboxed unless
// QUOTE_MESSAGES_SEND=1). WhatsApp starts as click-to-chat: the message
// waits as a to-do until a staff member presses send in their own WhatsApp.
// The WhatsApp Business Platform provider is written but stays off until
// Meta approves the templates (QUOTE_WHATSAPP_PROVIDER=cloud).
//
// runFollowups() is the scheduler's job: it claims due sequence steps,
// decides each one with followups.ts, and sends or reschedules. Whatever
// happens is recorded on the lead, so the timeline shows every message
// and every reminder that was skipped, and why.

import crypto from 'node:crypto'
import type { QuoteStore } from './store.js'
import type { DeskStore } from './deskStore.js'
import type { JobStore } from './jobStore.js'
import type { FollowupStore, SequenceRow } from './followupStore.js'
import { SEQUENCES, decide, type Channel, type FollowupCtx, type FollowupLead, type MessagingSettings, type SequenceKey, type Step } from './followups.js'
import { alertStaff, render, type AlertConfig, type AlertLog } from './alerts.js'
import { formatKes, inQuietHours, linkExpiry } from './desk.js'
import { industryLabel } from './industries.js'
import { modules } from './modules/index.js'

export interface WhatsAppProvider {
  name: 'click_to_chat' | 'cloud'
  // Click-to-chat: nothing is sent by the server; staff send it themselves
  staffSends: boolean
  send?(to: string, text: string, template: { key: string; waTemplateName: string | null; params: string[] }): Promise<string | null>
}

export const clickToChat: WhatsAppProvider = { name: 'click_to_chat', staffSends: true }

// WhatsApp Business Platform. Outside the 24-hour reply window Meta only
// delivers pre-approved templates, so each wording needs its approved
// template name (qe_message_templates.wa_template_name) and the
// placeholders become the template's body parameters, in order.
export function cloudWhatsApp(env = process.env): WhatsAppProvider {
  return {
    name: 'cloud',
    staffSends: false,
    async send(to, _text, template) {
      if (!template.waTemplateName) throw new Error(`no approved WhatsApp template for ${template.key}`)
      const res = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: to.replace(/\D/g, ''), type: 'template',
          template: {
            name: template.waTemplateName, language: { code: 'en' },
            components: [{ type: 'body', parameters: template.params.map(text => ({ type: 'text', text })) }],
          },
        }),
      })
      const body = await res.json().catch(() => ({})) as any
      if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 300)}`)
      return body?.messages?.[0]?.id ?? null
    },
  }
}

export interface MessagingDeps {
  store: QuoteStore
  desk: DeskStore
  jobs: JobStore
  followups: FollowupStore
  alerts: AlertConfig
  log: AlertLog
  messagesLive: boolean
  whatsapp: WhatsAppProvider
  sendEmail: (msg: { to: string[]; subject: string; text: string }) => Promise<unknown>
  publicUrl: string
  optOutSecret: string
  resumeDays: number
  now: () => Date
  newToken: () => string                 // 32 characters, the form's resume token shape
  newQuoteToken: () => string            // 43 characters, the quote link shape
  retryDelaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
}

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

// ── Opt-out links: signed, so nothing needs storing ─────────────────────────

export const optOutSig = (secret: string, leadId: string) =>
  crypto.createHmac('sha256', secret).update(`qe-optout:${leadId}`).digest('base64url').slice(0, 32)

export function optOutValid(secret: string, leadId: string, sig: string): boolean {
  const expected = Buffer.from(optOutSig(secret, leadId))
  const given = Buffer.from(sig)
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

export const optOutLink = (deps: Pick<MessagingDeps, 'publicUrl' | 'optOutSecret'>, leadId: string) =>
  deps.optOutSecret ? `${deps.publicUrl}/quote/stop?l=${leadId}&s=${optOutSig(deps.optOutSecret, leadId)}` : ''

// ── sendMessage ─────────────────────────────────────────────────────────────

export interface SendResult { status: 'sent' | 'queued' | 'skipped' | 'failed'; reason?: string; messageId?: string }

export async function sendMessage(
  deps: MessagingDeps,
  channel: Channel,
  templateKey: string,
  lead: FollowupLead,
  opts: { vars: Record<string, string>; quoteId?: string | null; sequenceId?: string | null; step?: string | null },
): Promise<SendResult> {
  const base = {
    leadId: lead.id, quoteId: opts.quoteId ?? null, channel, templateKey,
    sequenceId: opts.sequenceId ?? null, sequenceStep: opts.step ?? null,
  }
  const skip = async (reason: string, extra: { templateVersion?: number | null; renderedBody?: string | null } = {}) => {
    const messageId = await deps.store.recordMessage({ templateVersion: null, renderedBody: null, ...base, ...extra, status: 'skipped', skipReason: reason })
    return { status: 'skipped' as const, reason, messageId }
  }

  if (lead.optedOutAt) return skip('opted_out')
  const to = channel === 'whatsapp' ? lead.whatsappE164 : lead.email
  const consent = channel === 'whatsapp' ? lead.consentWhatsapp : lead.consentEmail
  if (!to) return skip('no_contact')
  if (!consent) return skip('no_consent')

  const template = await deps.store.messageTemplate(templateKey, channel)
  if (!template) {
    deps.log.error({ leadId: lead.id, templateKey, channel }, 'quote: message wording missing (run migration 006)')
    const messageId = await deps.store.recordMessage({ ...base, templateVersion: null, renderedBody: null, status: 'failed', error: 'template_missing' })
    return { status: 'failed', reason: 'template_missing', messageId }
  }
  const vars: Record<string, string> = { ...opts.vars, optout_link: channel === 'email' ? optOutLink(deps, lead.id) : '' }
  const text = render(template.body, vars)
  const message = { ...base, templateVersion: template.version, renderedBody: text }

  if (channel === 'whatsapp' && deps.whatsapp.staffSends) {
    const messageId = await deps.store.recordMessage({ ...message, status: 'queued', needsStaff: true })
    return { status: 'queued', messageId }
  }
  if (!deps.messagesLive) return skip('sandbox', message)
  if (inQuietHours(deps.now())) return skip('quiet_hours', message)

  const delays = deps.retryDelaysMs ?? [1000, 5000]
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  let lastError = ''
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      if (channel === 'email') {
        await deps.sendEmail({ to: [to], subject: render(template.subject ?? 'Viewora', vars), text })
      } else {
        const params = [...template.body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => vars[m[1]] ?? '')
        await deps.whatsapp.send!(to, text, { key: templateKey, waTemplateName: template.waTemplateName ?? null, params })
      }
      const messageId = await deps.store.recordMessage({ ...message, status: 'sent', sentAt: deps.now().toISOString() })
      return { status: 'sent', messageId }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      if (attempt < delays.length) await sleep(delays[attempt])
    }
  }
  deps.log.error({ leadId: lead.id, templateKey, channel, error: lastError }, 'quote: message failed after retries')
  const messageId = await deps.store.recordMessage({ ...message, status: 'failed', error: lastError.slice(0, 500) })
  return { status: 'failed', reason: 'provider_error', messageId }
}

// ── Starting and stopping sequences ─────────────────────────────────────────

export async function startSequence(deps: Pick<MessagingDeps, 'followups' | 'now'>, leadId: string, key: SequenceKey, opts: { subjectId?: string | null; step?: number; runAt?: Date } = {}) {
  const now = deps.now()
  return deps.followups.start({
    leadId, key, subjectId: opts.subjectId ?? null, nextStep: opts.step ?? 0,
    nextRunAt: (opts.runAt ?? now).toISOString(), startedAt: now.toISOString(),
  })
}

// Contact saved, or another step saved: the unfinished-form reminder
// counts 15 minutes from the latest save
export async function formSaved(deps: Pick<MessagingDeps, 'followups' | 'now'>, leadId: string, opts: { first: boolean }) {
  const runAt = new Date(deps.now().getTime() + 15 * 60_000)
  if (opts.first) await startSequence(deps, leadId, 'abandoned', { runAt })
  else await deps.followups.touch(leadId, 'abandoned', runAt.toISOString())
}

// The form gave a price: no more "finish your quote", send the quote
// itself (unless staff must price it), and tell the boss about big ones
export async function formCompleted(deps: MessagingDeps, input: { leadId: string; quoteId: string; mode: string; total: number | null; industry: string; source: string | null }) {
  await deps.followups.stop(input.leadId, 'completed', null)
  if (input.mode !== 'custom') await startSequence(deps, input.leadId, 'quote_followup', { subjectId: input.quoteId })
  const settings = await deps.followups.settings()
  if (settings.highValueAmount !== null && input.total !== null && input.total >= settings.highValueAmount && settings.highValueEmails.length) {
    const lead = await deps.followups.lead(input.leadId)
    await alertStaff(deps.store, deps.alerts, deps.log, {
      leadId: input.leadId, quoteId: input.quoteId, templateKey: 'staff_high_value', what: 'high-value alert', migration: '006',
      recipients: settings.highValueEmails,
      vars: {
        name: lead?.firstName ?? '', industry: input.industry, amount: formatKes(input.total), source: input.source ?? 'direct',
        admin_link: `${deps.alerts.adminUrl}/dashboard/quotes/${input.leadId}`,
      },
    })
  }
}

// Staff sent a quote (or a new version): its own link went with it, so the
// sequence starts at the 24-hour nudge
export const quoteSent = (deps: Pick<MessagingDeps, 'followups' | 'now'>, leadId: string, quoteId: string) =>
  startSequence(deps, leadId, 'quote_followup', { subjectId: quoteId, step: 1 })

export async function jobDelivered(deps: Pick<MessagingDeps, 'followups' | 'now'>, leadId: string, jobId: string) {
  await startSequence(deps, leadId, 'post_delivery', { subjectId: jobId })
  await startSequence(deps, leadId, 'renewal', { subjectId: jobId })
}

export const stopFollowups = (deps: Pick<MessagingDeps, 'followups'>, leadId: string, reason: string, actorId: string | null) =>
  deps.followups.stop(leadId, reason, actorId)

// ── The runner ──────────────────────────────────────────────────────────────

const DAY = 86_400_000
const longDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' })
const capExemptSteps = Object.values(SEQUENCES).flatMap(s => s.steps.filter(x => x.capExempt).map(x => x.id))

async function context(deps: MessagingDeps, seq: SequenceRow, lead: FollowupLead, settings: MessagingSettings): Promise<FollowupCtx> {
  const ctx: FollowupCtx = { lead, startedAt: seq.startedAt, settings }
  if (seq.key === 'abandoned') ctx.request = await deps.followups.latestRequest(lead.id)
  if (seq.key === 'quote_followup' && seq.subjectId) {
    const q = await deps.desk.quote(seq.subjectId)
    ctx.quote = q && { id: q.id!, status: q.status, mode: q.mode, sentAt: q.sentAt, viewedAt: q.viewedAt, validUntil: q.validUntil }
  }
  if ((seq.key === 'post_delivery' || seq.key === 'renewal') && seq.subjectId) {
    const j = await deps.jobs.job(seq.subjectId)
    // Marked delivered without a date: count from when it was marked
    ctx.job = j && { id: j.id, status: j.status, deliveredAt: j.deliveredAt ?? seq.startedAt, tourUrl: j.tourUrl }
  }
  return ctx
}

// What the wording can use for this step. Links are minted per message:
// a fresh resume token, or a new quote link (only hashes are stored).
async function varsFor(deps: MessagingDeps, seq: SequenceRow, ctx: FollowupCtx, channel: Channel): Promise<Record<string, string>> {
  const vars: Record<string, string> = { name: ctx.lead.firstName ?? '' }
  const now = deps.now()
  const industryOf = async (requestId: string | null | undefined) => {
    const r = requestId ? await deps.desk.request(requestId) : null
    return r ? industryLabel(r.moduleKey, r.flags, r.moduleKey ? modules[r.moduleKey]?.label : undefined) : ''
  }
  if (seq.key === 'abandoned' && ctx.request) {
    const token = deps.newToken()
    await deps.store.addResumeToken(ctx.request.id, hashToken(token), new Date(now.getTime() + deps.resumeDays * DAY).toISOString())
    vars.resume_link = `${deps.publicUrl}/quote?r=${token}`
    vars.industry = await industryOf(ctx.request.id)
  }
  if (seq.key === 'quote_followup' && ctx.quote) {
    const doc = await deps.desk.quote(ctx.quote.id)
    if (doc) {
      const token = deps.newQuoteToken()
      await deps.desk.markSent(doc.id!, null, { tokenHash: hashToken(token), channel, expiresAt: linkExpiry(doc.validUntil, now) })
      const selected = doc.options.find(o => o.selected) ?? doc.options[0]
      Object.assign(vars, {
        quote_link: `${deps.publicUrl}/quote/view/${token}`,
        amount: selected ? formatKes(selected.total, doc.currency) : '',
        valid_until: doc.validUntil ? longDate(doc.validUntil) : '',
        industry: await industryOf(doc.requestId),
      })
    }
  }
  if (ctx.job) {
    vars.tour_link = ctx.job.tourUrl ?? ''
    vars.review_link = ctx.settings.reviewUrl ?? ''
  }
  return vars
}

async function runOne(deps: MessagingDeps, seq: SequenceRow, settings: MessagingSettings) {
  const def = SEQUENCES[seq.key]
  const now = deps.now()
  const lead = await deps.followups.lead(seq.leadId)
  if (!def || !lead) return deps.followups.advance(seq.id, { nextStep: seq.nextStep, nextRunAt: null, status: 'stopped', stopReason: 'lead_gone' })
  const ctx = await context(deps, seq, lead, settings)
  const record = (step: Step, reason: string) => deps.store.recordMessage({
    leadId: lead.id, quoteId: ctx.quote?.id ?? null, channel: step.channels[0], templateKey: step.template, templateVersion: null,
    renderedBody: null, status: 'skipped', skipReason: reason, sequenceId: seq.id, sequenceStep: step.id,
  })

  for (let i = seq.nextStep; ; i++) {
    const step = def.steps[i]
    if (!step) return deps.followups.advance(seq.id, { nextStep: i, nextRunAt: null, status: 'completed' })
    const week = await deps.followups.weekCount(lead.id, new Date(now.getTime() - 7 * DAY).toISOString(), capExemptSteps)
    const d = decide(def, step, ctx, now, week)
    if (d.kind === 'stop') return deps.followups.advance(seq.id, { nextStep: i, nextRunAt: null, status: 'stopped', stopReason: d.reason })
    if (d.kind === 'wait') return deps.followups.advance(seq.id, { nextStep: i, nextRunAt: d.until.toISOString() })
    if (d.kind === 'skip') { await record(step, d.reason); continue }
    for (const channel of d.channels) {
      const vars = await varsFor(deps, seq, ctx, channel)
      await sendMessage(deps, channel, step.template, lead, { vars, quoteId: ctx.quote?.id ?? null, sequenceId: seq.id, step: step.id })
    }
  }
}

export async function runFollowups(deps: MessagingDeps, limit = 50): Promise<{ ran: number; failed: number; expired: number }> {
  const now = deps.now()
  // A WhatsApp to-do nobody sent in two days is stale: drop it
  const expired = await deps.followups.expireTasks(new Date(now.getTime() - 2 * DAY).toISOString())
  const settings = await deps.followups.settings()
  const due = await deps.followups.claimDue(now, limit)
  let failed = 0
  for (const seq of due) {
    try {
      await runOne(deps, seq, settings)
    } catch (e) {
      failed++
      deps.log.error({ sequenceId: seq.id, err: e instanceof Error ? e.message : String(e) }, 'quote: follow-up step failed; will retry in 15 minutes')
      await deps.followups.advance(seq.id, { nextStep: seq.nextStep, nextRunAt: new Date(now.getTime() + 15 * 60_000).toISOString() }).catch(() => {})
    }
  }
  return { ran: due.length, failed, expired }
}

// Production wiring from the environment; tests and the dev server override
export function messagingDeps(base: Pick<MessagingDeps, 'store' | 'desk' | 'jobs' | 'followups' | 'log' | 'alerts'>, overrides: Partial<MessagingDeps> = {}): MessagingDeps {
  return {
    messagesLive: process.env.QUOTE_MESSAGES_SEND === '1',
    whatsapp: process.env.QUOTE_WHATSAPP_PROVIDER === 'cloud' ? cloudWhatsApp() : clickToChat,
    sendEmail: base.alerts.send,
    publicUrl: (process.env.QUOTE_PUBLIC_URL ?? 'https://app.viewora.software').replace(/\/$/, ''),
    optOutSecret: process.env.QUOTE_OPTOUT_SECRET || process.env.ADMIN_SECRET || '',
    resumeDays: Number(process.env.QUOTE_RESUME_DAYS ?? 30),
    now: () => new Date(),
    newToken: () => crypto.randomBytes(24).toString('base64url'),
    newQuoteToken: () => crypto.randomBytes(32).toString('base64url'),
    ...base,
    ...overrides,
  }
}
