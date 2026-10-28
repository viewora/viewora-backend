import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import quoteRoutes from '../routes/quote.js'
import quoteAdminRoutes from '../routes/quoteAdmin.js'
import { memoryStore } from '../quote/store.js'
import { memoryAdminStore } from '../quote/adminStore.js'
import { memoryDeskStore } from '../quote/deskStore.js'
import { memoryJobStore } from '../quote/jobStore.js'
import { memoryFollowupStore } from '../quote/followupStore.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import {
  DEFAULT_MESSAGING, SEQUENCES, checkPlaceholders, dayBefore10am, decide, quietEnd, templateInfo, type FollowupCtx,
} from '../quote/followups.js'
import { messagingDeps, optOutSig, runFollowups } from '../quote/messaging.js'

process.env.ADMIN_SECRET = 'test-admin-secret'
const ADMIN = '00000000-0000-4000-8000-000000000001'
const SALES = '00000000-0000-4000-8000-000000000002'
const as = (who: string) => ({ authorization: 'Bearer test-admin-secret', 'x-admin-id': who })
const MIN = 60_000

// ── Pure rules ──────────────────────────────────────────────────────────────

const lead = { id: 'l1', firstName: 'Amina', whatsappE164: '+254712345670', email: 'a@example.com', consentWhatsapp: true, consentEmail: true, optedOutAt: null, stage: 'new' }
const ctxAt = (saved: string, patch: Partial<FollowupCtx> = {}): FollowupCtx => ({
  lead, startedAt: saved, settings: DEFAULT_MESSAGING,
  request: { id: 'r1', stepReached: 2, completedAt: null, lastSavedAt: saved }, ...patch,
})
const none = { count: 0, oldestAt: null }

test('follow-up rules: quiet hours end at 07:00 Nairobi; expiry reminder the day before at 10:00', () => {
  assert.equal(quietEnd(new Date('2026-11-02T19:00:00Z')).toISOString(), '2026-11-03T04:00:00.000Z')   // 22:00 → 07:00 next day
  assert.equal(quietEnd(new Date('2026-11-02T02:00:00Z')).toISOString(), '2026-11-02T04:00:00.000Z')   // 05:00 → 07:00 same day
  assert.equal(dayBefore10am('2026-11-09')!.toISOString(), '2026-11-08T07:00:00.000Z')
})

test('follow-up rules: send, wait, skip and stop', () => {
  const def = SEQUENCES.abandoned
  const [wa, email] = def.steps
  const saved = '2026-11-02T09:00:00Z'                       // 12:00 Nairobi
  const at = (min: number) => new Date(Date.parse(saved) + min * MIN)

  assert.deepEqual(decide(def, wa, ctxAt(saved), at(10), none), { kind: 'wait', until: at(15), reason: 'not_due' })
  assert.deepEqual(decide(def, wa, ctxAt(saved), at(16), none), { kind: 'send', channels: ['whatsapp'] })
  assert.deepEqual(decide(def, wa, ctxAt(saved), at(25 * 60), none), { kind: 'skip', reason: 'too_late' })
  assert.deepEqual(decide(def, email, ctxAt(saved), at(24 * 60 + 1), none), { kind: 'send', channels: ['email'] })
  // Opted out or finished: the whole sequence stops
  assert.deepEqual(decide(def, wa, ctxAt(saved, { lead: { ...lead, optedOutAt: saved } }), at(16), none), { kind: 'stop', reason: 'opted_out' })
  assert.deepEqual(decide(def, wa, ctxAt(saved, { request: { id: 'r1', stepReached: 5, completedAt: saved, lastSavedAt: saved } }), at(16), none), { kind: 'stop', reason: 'completed' })
  // No WhatsApp consent: nothing to send this step on
  assert.deepEqual(decide(def, wa, ctxAt(saved, { lead: { ...lead, consentWhatsapp: false } }), at(16), none), { kind: 'skip', reason: 'no_consent' })

  // 20:50 save: due at 21:05, so it waits for 07:00
  const late = '2026-11-02T17:50:00Z'
  assert.deepEqual(decide(def, wa, ctxAt(late), new Date('2026-11-02T18:06:00Z'), none),
    { kind: 'wait', until: new Date('2026-11-03T04:00:00Z'), reason: 'quiet_hours' })

  // The weekly cap: wait until the oldest message is a week old, or skip if that is too late
  const capped = { count: 3, oldestAt: '2026-10-30T09:00:00Z' }
  assert.deepEqual(decide(def, email, ctxAt(saved), at(24 * 60 + 1), capped), { kind: 'wait', until: new Date('2026-11-06T09:00:00Z'), reason: 'weekly_cap' })
  assert.deepEqual(decide(def, wa, ctxAt(saved), at(16), capped), { kind: 'skip', reason: 'weekly_cap' })
  // The quote itself is what they asked for: the cap does not apply
  const q = SEQUENCES.quote_followup
  const quote = { id: 'q1', status: 'sent', mode: 'instant', sentAt: saved, viewedAt: null, validUntil: '2026-11-09' }
  assert.deepEqual(decide(q, q.steps[0], ctxAt(saved, { quote }), at(1), capped), { kind: 'send', channels: ['whatsapp', 'email'] })
  // Opened already: no "did you see it?" nudge
  assert.deepEqual(decide(q, q.steps[1], ctxAt(saved, { quote: { ...quote, viewedAt: saved } }), at(24 * 60 + 5), none), { kind: 'skip', reason: 'opened' })
  // Booked: selling stops
  assert.deepEqual(decide(q, q.steps[1], ctxAt(saved, { quote, lead: { ...lead, stage: 'booked' } }), at(24 * 60 + 5), none), { kind: 'stop', reason: 'booked' })
})

test('follow-up rules: placeholders the wording uses must exist, and links must stay', () => {
  const info = templateInfo('quote_nudge')!
  assert.deepEqual(checkPlaceholders(info, ['Hi {{name}}, {{quote_link}}']), { unknown: [], missing: [] })
  assert.deepEqual(checkPlaceholders(info, ['Hi {{nmae}}']), { unknown: ['nmae'], missing: ['quote_link'] })
})

// ── Routes and the runner over the memory store ─────────────────────────────

const templates = {
  'abandoned_resume:whatsapp': { version: 1, subject: null, body: 'Hi {{name}}, finish your {{industry}} quote: {{resume_link}}' },
  'abandoned_resume:email': { version: 1, subject: 'Your quote is saved', body: 'Hi {{name}}, {{resume_link}} Stop: {{optout_link}}' },
  'quote_ready:whatsapp': { version: 1, subject: null, body: 'Hi {{name}}, {{amount}}: {{quote_link}}' },
  'quote_ready:email': { version: 1, subject: 'Your quote: {{amount}}', body: 'Hi {{name}}, {{quote_link}} Stop: {{optout_link}}' },
  'quote_nudge:whatsapp': { version: 1, subject: null, body: 'Hi {{name}}, did you see {{quote_link}}?' },
  'quote_nudge:email': { version: 1, subject: 'Did you see it?', body: '{{quote_link}} {{optout_link}}' },
  'quote_link:whatsapp': { version: 1, subject: null, body: 'Hi {{name}}: {{quote_link}}' },
}

async function setup(start = '2026-11-02T09:00:00Z') {                  // Monday, 12:00 in Nairobi
  let clock = new Date(start)
  const now = () => clock
  const store = memoryStore({
    rateTable: rateTableV1, consent: { id: 'c1', body: 'Consent wording' }, templates, recipients: [], clock: now,
    staff: [
      { userId: ADMIN, displayName: 'Peter', role: 'admin', discountLimitBp: 10_000, email: 'peter@example.com', active: true },
      { userId: SALES, displayName: 'Wanjiru', role: 'sales', discountLimitBp: 500, email: null, active: true },
    ],
  })
  const desk = memoryDeskStore(() => store.dump())
  const jobs = memoryJobStore(() => store.dump())
  const followups = memoryFollowupStore(() => store.dump())
  const emails: any[] = []
  const alerts = { liveSend: false, extraRecipients: [], adminUrl: 'https://admin.example.com', send: async (m: any) => { emails.push(m) } }
  const messaging = { now, publicUrl: 'https://app.example.com', optOutSecret: 'optout-test', messagesLive: false }
  const pending: Promise<unknown>[] = []
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store, desk, jobs, alerts, followups, messaging, onAlert: p => pending.push(p), payments: { paystack: null, now } })
  await fastify.register(quoteAdminRoutes, {
    prefix: '/admin/quote', store, desk, jobs, followups, adminStore: memoryAdminStore(() => store.dump()),
    messagesLive: false, publicUrl: 'https://app.example.com', now, payments: { paystack: null, now },
  })
  const deps = messagingDeps({ store, desk, jobs, followups, alerts, log: fastify.log }, messaging)
  const settle = async () => { await Promise.all(pending.splice(0)) }
  const pub = (method: string, url: string, payload?: unknown) => fastify.inject({ method: method as any, url, ...(payload !== undefined ? { payload: payload as any } : {}) })
  const call = (method: string, url: string, who = ADMIN, payload?: unknown) =>
    fastify.inject({ method: method as any, url, headers: as(who), ...(payload !== undefined ? { payload: payload as any } : {}) })
  const later = (min: number) => { clock = new Date(clock.getTime() + min * MIN) }
  const run = async () => { await settle(); return runFollowups(deps) }

  // A visitor gives their number and the first details, then leaves
  async function started(o: { email?: string } = {}) {
    const res = await pub('POST', '/quote/requests', { moduleKey: 'homes', entry: { source: 'instagram' } })
    const token = res.json().token as string
    const patch = (payload: object) => pub('PATCH', `/quote/requests/${token}`, payload)
    assert.equal((await patch({ step: 'contact', clientType: 'owner', firstName: 'Amina', whatsapp: '0712 345 670', email: o.email ?? '', consent: true, consentTextId: 'c1' })).statusCode, 200)
    assert.equal((await patch({ step: 'details', details: { size: '2br', purpose: 'let' } })).statusCode, 200)
    await settle()
    return { token, patch, leadId: store.dump().leads[0].id }
  }
  return { store, followups, pub, call, later, run, settle, started, now, emails }
}

test('unfinished form: a WhatsApp to-do after 15 minutes with a working resume link, then email the next day', async () => {
  const t = await setup()
  const { leadId } = await t.started({ email: 'amina@example.com' })

  t.later(10)
  await t.run()
  assert.equal(t.store.dump().messages.filter(m => m.sequenceId).length, 0, 'nothing before 15 minutes')

  t.later(6)
  await t.run()
  const tasks = (await t.call('GET', '/admin/quote/followups/tasks', SALES)).json()
  assert.equal(tasks.tasks.length, 1)
  const task = tasks.tasks[0]
  assert.equal(task.templateKey, 'abandoned_resume')
  assert.match(task.body, /^Hi Amina, finish your Homes and real estate quote: https:\/\/app\.example\.com\/quote\?r=[A-Za-z0-9_-]{32}$/)
  assert.ok(task.waUrl.startsWith('https://wa.me/254712345670?text='))
  // The reminder's own token resumes the same request
  const resumeToken = task.body.split('?r=')[1]
  const resumed = await t.pub('GET', `/quote/requests/${resumeToken}`)
  assert.equal(resumed.statusCode, 200)
  assert.equal(resumed.json().request.stepReached, 3)

  // Staff send it from their WhatsApp; someone else can't send it twice
  assert.equal((await t.call('POST', `/admin/quote/followups/tasks/${task.id}/sent`, SALES)).statusCode, 200)
  assert.equal((await t.call('POST', `/admin/quote/followups/tasks/${task.id}/sent`, ADMIN)).statusCode, 409)

  // Next day: the email (sandbox here, so recorded as skipped, never sent)
  t.later(24 * 60)
  await t.run()
  const email = t.store.dump().messages.find(m => m.channel === 'email' && m.templateKey === 'abandoned_resume')!
  assert.equal(email.status, 'skipped')
  assert.equal(email.skipReason, 'sandbox')
  assert.match(email.renderedBody!, /Stop: https:\/\/app\.example\.com\/quote\/stop\?l=/)
  const seq = (await t.call('GET', `/admin/quote/leads/${leadId}/followups`)).json().sequences[0]
  assert.equal(seq.status, 'completed')
  assert.equal(t.emails.length, 0)
})

test('unfinished form: saving again pushes the reminder back; finishing stops it and sends the quote', async () => {
  const t = await setup()
  const { patch, leadId } = await t.started()
  t.later(10)
  await patch({ step: 'extras', addons: {} })
  await t.settle()
  t.later(10)
  await t.run()
  assert.equal(t.store.dump().messages.filter(m => m.sequenceId).length, 0, 'the 15 minutes count from the last save')

  await patch({ step: 'where', location: { town: 'Kilimani, Nairobi' }, timing: 'this_month' })
  await t.run()
  const seqs = (await t.call('GET', `/admin/quote/leads/${leadId}/followups`)).json().sequences
  assert.deepEqual(seqs.map((s: any) => [s.key, s.status, s.stopReason]).sort(),
    [['abandoned', 'stopped', 'completed'], ['quote_followup', 'active', null]])
  // The quote link went out as a WhatsApp to-do (no email given), and it opens the quote
  const task = (await t.call('GET', '/admin/quote/followups/tasks')).json().tasks[0]
  assert.equal(task.templateKey, 'quote_ready')
  const quoteToken = task.body.split('/quote/view/')[1]
  assert.equal((await t.pub('GET', `/quote/view/${quoteToken}`)).statusCode, 200)
  assert.equal(t.store.dump().leads[0].stage, 'quoted')
})

test('unfinished form at 20:50: the reminder waits for 07:00', async () => {
  const t = await setup('2026-11-02T17:50:00Z')
  const { leadId } = await t.started()
  t.later(16)
  await t.run()
  assert.equal((await t.call('GET', '/admin/quote/followups/tasks')).json().tasks.length, 0)
  const seq = (await t.call('GET', `/admin/quote/leads/${leadId}/followups`)).json().sequences[0]
  assert.equal(seq.nextRunAt, '2026-11-03T04:00:00.000Z')
})

test('a reply on WhatsApp, "they replied", lost and opt-out all stop the follow-ups', async () => {
  const t = await setup()
  const { leadId } = await t.started({ email: 'amina@example.com' })
  t.later(16)
  await t.run()
  assert.equal(t.store.dump().messages.filter(m => m.status === 'queued').length, 1)

  // The WhatsApp webhook hook: their number wrote to us
  assert.equal(await t.followups.replied('+254712345670'), leadId)
  assert.equal(t.store.dump().messages.filter(m => m.status === 'queued').length, 0, 'the unsent to-do is dropped')
  const seq = (await t.call('GET', `/admin/quote/leads/${leadId}/followups`)).json().sequences[0]
  assert.deepEqual([seq.status, seq.stopReason], ['stopped', 'replied'])
  assert.equal(await t.followups.replied('+254700000000'), null, 'an unknown number does nothing')

  // The opt-out link in an email: the signature must match
  const sig = optOutSig('optout-test', leadId)
  assert.equal((await t.pub('GET', `/quote/stop?l=${leadId}&s=${'x'.repeat(32)}`)).statusCode, 404)
  assert.deepEqual((await t.pub('GET', `/quote/stop?l=${leadId}&s=${sig}`)).json(), { optedOut: false })
  assert.deepEqual((await t.pub('POST', '/quote/stop', { l: leadId, s: sig })).json(), { optedOut: true })
  const l = t.store.dump().leads[0]
  assert.ok(l.optedOutAt)
  assert.equal(l.consentWhatsapp, false)
  // Nothing starts again for an opted-out lead
  await t.pub('POST', '/quote/requests', { moduleKey: 'homes' })
  assert.ok(t.store.dump().audit.some(a => a.action === 'opted_out' && a.entityId === leadId))
})

test('staff sending a quote starts the nudges; marking it booked stops them', async () => {
  const t = await setup()
  const { patch, leadId } = await t.started()
  await patch({ step: 'extras', addons: {} })
  await patch({ step: 'where', location: { town: 'Kilimani, Nairobi' }, timing: 'this_month' })
  const quote = t.store.dump().quotes.at(-1)!
  assert.equal(quote.validUntil, '2026-11-09')
  await t.run()
  assert.equal((await t.call('POST', `/admin/quote/quotes/${quote.id}/send`, SALES, { channel: 'link' })).statusCode, 200)
  let seq = (await t.call('GET', `/admin/quote/leads/${leadId}/followups`)).json().sequences.find((s: any) => s.status === 'active')
  assert.deepEqual([seq.key, seq.nextStep, seq.nextLabel], ['quote_followup', 1, 'Nudge if not opened'])

  // A day later, not opened: the nudge
  t.later(24 * 60 + 5)
  await t.run()
  const nudges = t.store.dump().messages.filter(m => m.templateKey === 'quote_nudge')
  assert.equal(nudges.length, 1)

  assert.equal((await t.call('PATCH', `/admin/quote/leads/${leadId}`, SALES, { stage: 'booked' })).statusCode, 200)
  seq = (await t.call('GET', `/admin/quote/leads/${leadId}/followups`)).json().sequences.find((s: any) => s.key === 'quote_followup' && s.stopReason && s.stopReason !== 'restarted')
  assert.equal(seq.stopReason, 'booked')
  assert.equal(nudges[0].status, 'skipped', 'the unsent nudge is dropped')
})

test('templates: staff see every wording; only admins save; bad placeholders are refused', async () => {
  const t = await setup()
  const list = (await t.call('GET', '/admin/quote/templates', SALES)).json()
  const nudge = list.templates.find((x: any) => x.key === 'quote_nudge' && x.channel === 'whatsapp')
  assert.equal(nudge.current.version, 1)
  assert.ok(nudge.placeholders.includes('quote_link'))

  const url = '/admin/quote/templates/quote_nudge/whatsapp'
  assert.equal((await t.call('PUT', url, SALES, { subject: null, body: 'Hi {{name}} {{quote_link}}' })).statusCode, 403)
  let res = await t.call('PUT', url, ADMIN, { subject: null, body: 'Hi {{nmae}} {{quote_link}}' })
  assert.equal(res.statusCode, 422)
  assert.equal(res.json().code, 'UNKNOWN_PLACEHOLDER')
  res = await t.call('PUT', url, ADMIN, { subject: null, body: 'Hi {{name}}, did you see your quote?' })
  assert.equal(res.json().code, 'MISSING_PLACEHOLDER')
  assert.equal((await t.call('PUT', '/admin/quote/templates/quote_nudge/email', ADMIN, { subject: '', body: '{{quote_link}}' })).json().code, 'SUBJECT_REQUIRED')
  res = await t.call('PUT', url, ADMIN, { subject: null, body: 'Habari {{name}}, umeona {{quote_link}}?' })
  assert.deepEqual(res.json(), { version: 2 })

  const preview = (await t.call('POST', '/admin/quote/templates/preview', SALES, { key: 'quote_nudge', channel: 'whatsapp', subject: null, body: 'Hi {{name}}: {{amount}}' })).json()
  assert.equal(preview.body, 'Hi Amina: KES 15,000')
  assert.deepEqual(preview.check.missing, ['quote_link'])

  const after = (await t.call('GET', '/admin/quote/templates')).json().templates.find((x: any) => x.key === 'quote_nudge' && x.channel === 'whatsapp')
  assert.deepEqual(after.history.map((h: any) => [h.version, h.updatedByName]), [[2, 'Peter'], [1, null]])
  assert.ok(t.store.dump().audit.some(a => a.entityType === 'template' && a.action === 'saved'))
})

test('messaging settings: admins only, validated', async () => {
  const t = await setup()
  const body = { weeklyCap: 2, highValueAmount: 100_000, highValueEmails: ['Peter@Example.com'], reviewUrl: 'https://g.page/r/abc/review' }
  assert.equal((await t.call('PUT', '/admin/quote/messaging-settings', SALES, body)).statusCode, 403)
  assert.equal((await t.call('PUT', '/admin/quote/messaging-settings', ADMIN, { ...body, reviewUrl: 'http://x.example' })).statusCode, 400)
  assert.equal((await t.call('PUT', '/admin/quote/messaging-settings', ADMIN, { ...body, highValueAmount: 1.5 })).statusCode, 400)
  const saved = (await t.call('PUT', '/admin/quote/messaging-settings', ADMIN, body)).json().settings
  assert.deepEqual(saved.highValueEmails, ['peter@example.com'])
  assert.equal((await t.call('GET', '/admin/quote/messaging-settings', SALES)).json().settings.weeklyCap, 2)
})
