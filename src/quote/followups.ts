// Follow-up sequences: the spec's trigger table as config, and the rules
// that decide, for one due step, whether a message goes now, waits, is
// skipped or stops the whole sequence. No I/O here; messaging.ts runs it.
//
// Rules, in order: never message an opted-out lead; stop when the lead has
// moved on (booked, lost, completed the form); skip a step that no longer
// applies (the quote was opened); wait until the step is due; give up if
// it is too late to make sense; wait out quiet hours (21:00-07:00 Nairobi);
// use a channel the lead agreed to; and keep to the weekly cap.

import { inQuietHours } from './desk.js'

export type Channel = 'whatsapp' | 'email'
export type SequenceKey = 'abandoned' | 'quote_followup' | 'post_delivery' | 'renewal'

export interface FollowupLead {
  id: string
  firstName: string | null
  whatsappE164: string | null
  email: string | null
  consentWhatsapp: boolean
  consentEmail: boolean
  optedOutAt: string | null
  stage: string
}

export interface FollowupCtx {
  lead: FollowupLead
  startedAt: string                        // when the sequence (re)started
  request?: { id: string; stepReached: number; completedAt: string | null; lastSavedAt: string } | null
  quote?: { id: string; status: string; mode: string; sentAt: string | null; viewedAt: string | null; validUntil: string | null } | null
  job?: { id: string; status: string; deliveredAt: string | null; tourUrl: string | null } | null
  settings: MessagingSettings
}

export interface MessagingSettings {
  weeklyCap: number                        // automated messages per lead per 7 days
  highValueAmount: number | null           // whole KES; a completed quote at or above alerts highValueEmails
  highValueEmails: string[]
  reviewUrl: string | null                 // Google review link; the review step waits for it
}

// Defaults until an admin changes them. No high-value threshold or review
// link is assumed: those steps stay off until someone sets them.
export const DEFAULT_MESSAGING: MessagingSettings = { weeklyCap: 3, highValueAmount: null, highValueEmails: [], reviewUrl: null }

export interface Step {
  id: string
  template: string
  channels: Channel[]                      // first one the lead can receive, or every one with `all`
  all?: boolean
  capExempt?: boolean                      // the client asked for it (their quote), so the cap does not apply
  due(ctx: FollowupCtx): Date | null       // null: does not apply to this lead, skip
  skip?(ctx: FollowupCtx): string | null
  lateAfterMin: number                     // past due by this much, it no longer makes sense
}

export interface SequenceDef {
  key: SequenceKey
  label: string
  stop(ctx: FollowupCtx): string | null    // ends the whole sequence
  steps: Step[]
}

const MIN = 60_000
const DAY = 1440 * MIN
const at = (iso: string | null | undefined, plusMin: number) => (iso ? new Date(Date.parse(iso) + plusMin * MIN) : null)
const BOOKED = ['booked', 'delivered', 'paid']
const QUOTE_OVER = ['accepted', 'lost', 'superseded', 'expired']

// 10:00 Nairobi (07:00 UTC) on the day before a YYYY-MM-DD date
export function dayBefore10am(date: string | null): Date | null {
  if (!date) return null
  return new Date(Date.parse(`${date}T07:00:00Z`) - DAY)
}

const noTour = (ctx: FollowupCtx) => (ctx.job?.tourUrl ? null : 'no_tour_link')

const quoteStop = (ctx: FollowupCtx) =>
  ctx.lead.stage === 'lost' ? 'lost'
    : BOOKED.includes(ctx.lead.stage) ? 'booked'
      : !ctx.quote ? 'no_quote'
        : QUOTE_OVER.includes(ctx.quote.status) ? `quote_${ctx.quote.status}` : null

export const SEQUENCES: Record<SequenceKey, SequenceDef> = {
  // Gave their number, then left before the price
  abandoned: {
    key: 'abandoned',
    label: 'Unfinished form',
    stop: ctx => ctx.lead.stage === 'lost' ? 'lost'
      : !ctx.request ? 'no_request'
        : ctx.request.completedAt ? 'completed' : null,
    steps: [
      { id: 'resume_whatsapp', template: 'abandoned_resume', channels: ['whatsapp'], lateAfterMin: 1440,
        due: ctx => at(ctx.request?.lastSavedAt, 15) },
      { id: 'resume_email', template: 'abandoned_resume', channels: ['email'], lateAfterMin: 3 * 1440,
        due: ctx => at(ctx.request?.lastSavedAt, 1440) },
    ],
  },
  // A quote is out: the link itself (form quotes), then nudges until it is
  // booked, lost or expires
  quote_followup: {
    key: 'quote_followup',
    label: 'Quote follow-up',
    stop: quoteStop,
    steps: [
      { id: 'quote_ready', template: 'quote_ready', channels: ['whatsapp', 'email'], all: true, capExempt: true, lateAfterMin: 1440,
        due: ctx => new Date(ctx.startedAt) },
      { id: 'not_opened', template: 'quote_nudge', channels: ['whatsapp', 'email'], lateAfterMin: 2 * 1440,
        due: ctx => at(ctx.quote?.sentAt, 1440),
        skip: ctx => (ctx.quote?.viewedAt ? 'opened' : null) },
      { id: 'not_accepted', template: 'quote_adjust', channels: ['whatsapp', 'email'], lateAfterMin: 2 * 1440,
        // Only for a quote they opened; a quote never opened already had the nudge
        due: ctx => at(ctx.quote?.viewedAt, 2 * 1440),
        skip: ctx => {
          const due = at(ctx.quote?.viewedAt, 2 * 1440)
          const expiry = dayBefore10am(ctx.quote?.validUntil ?? null)
          return due && expiry && due >= expiry ? 'expiry_reminder_first' : null
        } },
      { id: 'expiring', template: 'quote_expiry', channels: ['whatsapp', 'email'], lateAfterMin: 11 * 60,
        due: ctx => dayBefore10am(ctx.quote?.validUntil ?? null) },
    ],
  },
  post_delivery: {
    key: 'post_delivery',
    label: 'After delivery',
    stop: ctx => ctx.lead.stage === 'lost' ? 'lost' : !ctx.job ? 'no_job' : ctx.job.status === 'cancelled' ? 'cancelled' : null,
    steps: [
      { id: 'review', template: 'review_request', channels: ['whatsapp', 'email'], lateAfterMin: 7 * 1440,
        due: ctx => at(ctx.job?.deliveredAt, 2 * 1440),
        skip: ctx => (!ctx.settings.reviewUrl ? 'no_review_link' : noTour(ctx)) },
      { id: 'hosting_offer', template: 'hosting_offer', channels: ['email', 'whatsapp'], lateAfterMin: 14 * 1440,
        due: ctx => at(ctx.job?.deliveredAt, 14 * 1440), skip: noTour },
    ],
  },
  renewal: {
    key: 'renewal',
    label: 'Hosting renewal',
    stop: ctx => ctx.lead.stage === 'lost' ? 'lost' : !ctx.job ? 'no_job' : ctx.job.status === 'cancelled' ? 'cancelled' : null,
    steps: [
      // Month 11 of the first year of hosting
      { id: 'renewal', template: 'renewal_reminder', channels: ['whatsapp', 'email'], lateAfterMin: 30 * 1440,
        due: ctx => at(ctx.job?.deliveredAt, 335 * 1440), skip: noTour },
    ],
  },
}

// Booking ends the selling sequences; replying, losing or opting out ends all
export const STOPPED_BY: Record<string, SequenceKey[] | 'all'> = {
  booked: ['abandoned', 'quote_followup'],
  completed: ['abandoned'],
  replied: 'all',
  lost: 'all',
  opted_out: 'all',
  staff: 'all',
}

// Next 07:00 in Nairobi (04:00 UTC) at or after `now`
export function quietEnd(now: Date): Date {
  const d = new Date(now)
  d.setUTCHours(4, 0, 0, 0)
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 1)
  return d
}

export function channelsFor(step: Step, lead: FollowupLead): Channel[] {
  const ok = step.channels.filter(c => c === 'whatsapp'
    ? lead.consentWhatsapp && !!lead.whatsappE164
    : lead.consentEmail && !!lead.email)
  return step.all ? ok : ok.slice(0, 1)
}

export type Decision =
  | { kind: 'send'; channels: Channel[] }
  | { kind: 'wait'; until: Date; reason: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'stop'; reason: string }

// `week` counts the lead's automated messages in the last 7 days that the
// cap applies to, and when the oldest of them went
export function decide(def: SequenceDef, step: Step, ctx: FollowupCtx, now: Date, week: { count: number; oldestAt: string | null }): Decision {
  if (ctx.lead.optedOutAt) return { kind: 'stop', reason: 'opted_out' }
  const stop = def.stop(ctx)
  if (stop) return { kind: 'stop', reason: stop }
  const skip = step.skip?.(ctx)
  if (skip) return { kind: 'skip', reason: skip }
  const due = step.due(ctx)
  if (!due) return { kind: 'skip', reason: 'not_applicable' }
  if (due > now) return { kind: 'wait', until: due, reason: 'not_due' }
  const latest = new Date(due.getTime() + step.lateAfterMin * MIN)
  if (now > latest) return { kind: 'skip', reason: 'too_late' }
  if (inQuietHours(now)) {
    const until = quietEnd(now)
    return until > latest ? { kind: 'skip', reason: 'quiet_hours' } : { kind: 'wait', until, reason: 'quiet_hours' }
  }
  const channels = channelsFor(step, ctx.lead)
  if (!channels.length) return { kind: 'skip', reason: 'no_consent' }
  if (!step.capExempt && week.count >= ctx.settings.weeklyCap) {
    const until = week.oldestAt ? new Date(Date.parse(week.oldestAt) + 7 * DAY) : latest
    return until > latest ? { kind: 'skip', reason: 'weekly_cap' } : { kind: 'wait', until, reason: 'weekly_cap' }
  }
  return { kind: 'send', channels }
}

// ── Templates ───────────────────────────────────────────────────────────────
// What staff can edit, and which placeholders each one understands. The
// wording lives in qe_message_templates; this is only the catalogue.

export interface TemplateInfo {
  key: string
  label: string
  when: string
  channels: Channel[]
  placeholders: string[]
  needs?: string[]                         // a message without these is useless
  staff?: boolean                          // goes to staff, not the client
}

const P_QUOTE = ['name', 'industry', 'quote_link', 'amount', 'valid_until', 'optout_link']
export const TEMPLATE_CATALOG: TemplateInfo[] = [
  { key: 'abandoned_resume', label: 'Finish your quote', when: '15 minutes after someone leaves the form (WhatsApp), and the next day (email)',
    channels: ['whatsapp', 'email'], placeholders: ['name', 'industry', 'resume_link', 'optout_link'], needs: ['resume_link'] },
  { key: 'quote_ready', label: 'Your quote', when: 'Right after the form gives a price',
    channels: ['whatsapp', 'email'], placeholders: P_QUOTE, needs: ['quote_link'] },
  { key: 'quote_nudge', label: 'Quote not opened', when: '24 hours after a quote is sent, if it was not opened',
    channels: ['whatsapp', 'email'], placeholders: P_QUOTE, needs: ['quote_link'] },
  { key: 'quote_adjust', label: 'Anything to adjust?', when: '48 hours after a quote was opened, if not booked',
    channels: ['whatsapp', 'email'], placeholders: P_QUOTE, needs: ['quote_link'] },
  { key: 'quote_expiry', label: 'Quote expires tomorrow', when: 'At 10:00 the day before a quote expires',
    channels: ['whatsapp', 'email'], placeholders: P_QUOTE, needs: ['quote_link'] },
  { key: 'review_request', label: 'Review request', when: '2 days after the tour is delivered (needs the review link in settings)',
    channels: ['whatsapp', 'email'], placeholders: ['name', 'tour_link', 'review_link', 'optout_link'], needs: ['review_link'] },
  { key: 'hosting_offer', label: 'Hosting and subscription offer', when: '14 days after delivery',
    channels: ['whatsapp', 'email'], placeholders: ['name', 'tour_link', 'optout_link'] },
  { key: 'renewal_reminder', label: 'Hosting renewal', when: 'Month 11 after delivery',
    channels: ['whatsapp', 'email'], placeholders: ['name', 'tour_link', 'optout_link'] },
  { key: 'quote_link', label: 'Quote sent by staff', when: 'When staff send a quote from the editor',
    channels: ['whatsapp', 'email'], placeholders: ['name', 'industry', 'quote_link', 'amount', 'valid_until', 'staff_name'], needs: ['quote_link'] },
  { key: 'deposit_paid', label: 'Deposit received', when: 'When a deposit is paid',
    channels: ['email'], placeholders: ['name', 'amount', 'balance', 'option', 'quote_ref', 'industry'] },
  { key: 'balance_request', label: 'Balance request', when: 'Staff send it from the job page after delivery',
    channels: ['whatsapp'], placeholders: ['name', 'amount', 'pay_link'], needs: ['pay_link'] },
  { key: 'staff_new_lead', label: 'Staff: new lead', when: 'A new lead gives their number', staff: true,
    channels: ['email'], placeholders: ['name', 'industry', 'client_type', 'source', 'admin_link'] },
  { key: 'staff_high_value', label: 'Staff: high-value lead', when: 'A form quote at or above the high-value amount', staff: true,
    channels: ['email'], placeholders: ['name', 'industry', 'amount', 'source', 'admin_link'] },
  { key: 'staff_deposit_paid', label: 'Staff: deposit paid', when: 'A deposit is paid', staff: true,
    channels: ['email'], placeholders: ['name', 'amount', 'option', 'quote_ref', 'industry', 'admin_link'] },
]
export const templateInfo = (key: string) => TEMPLATE_CATALOG.find(t => t.key === key)

// Placeholders the wording uses that the template does not know, and
// required ones it leaves out
export function checkPlaceholders(info: TemplateInfo, texts: string[]): { unknown: string[]; missing: string[] } {
  const used = new Set(texts.flatMap(t => [...t.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1])))
  return {
    unknown: [...used].filter(p => !info.placeholders.includes(p)),
    missing: (info.needs ?? []).filter(p => !used.has(p)),
  }
}

// Example values for the editor's preview (clearly examples, not a real lead)
export const SAMPLE_VARS: Record<string, string> = {
  name: 'Amina', industry: 'Homes and real estate', client_type: 'Owner', source: 'instagram',
  quote_link: 'https://app.viewora.software/quote/view/example', resume_link: 'https://app.viewora.software/quote?r=example',
  amount: 'KES 15,000', balance: 'KES 7,500', valid_until: '4 November 2026', option: 'Standard', quote_ref: 'Q-EXAMPLE-v1',
  tour_link: 'https://app.viewora.software/tour/example', review_link: 'https://g.page/r/example/review',
  pay_link: 'https://checkout.paystack.com/example', staff_name: 'The Viewora team',
  admin_link: 'https://admin.viewora.software/dashboard/quotes/example', optout_link: 'https://app.viewora.software/quote/stop?example',
}
