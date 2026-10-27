import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import Fastify from 'fastify'

import quoteRoutes from '../routes/quote.js'
import quoteAdminRoutes from '../routes/quoteAdmin.js'
import { memoryStore } from '../quote/store.js'
import { memoryAdminStore } from '../quote/adminStore.js'
import { memoryDeskStore } from '../quote/deskStore.js'
import { memoryJobStore } from '../quote/jobStore.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import { docFromEngine } from '../quote/desk.js'
import { price } from '../quote/engine/price.js'
import { modules } from '../quote/modules/index.js'
import { DEFAULT_BOOKING, bookingDays, csvCell, payBlocker, profit, slotOpen, trackerCsv, type JobRecord } from '../quote/jobs.js'
import { fakePaystack, paystackFromEnv, signatureValid } from '../quote/paystack.js'
import { issueInvoice } from '../quote/invoicing.js'
import { recheckPayments, paymentDeps } from '../quote/payments.js'

process.env.ADMIN_SECRET = 'test-admin-secret'
const ADMIN = '00000000-0000-4000-8000-000000000001'
const SALES = '00000000-0000-4000-8000-000000000002'
const VIEWER = '00000000-0000-4000-8000-000000000004'
const as = (who: string) => ({ authorization: 'Bearer test-admin-secret', 'x-admin-id': who })
const SECRET = 'sk_test_quote_secret'
const sign = (body: string) => crypto.createHmac('sha512', SECRET).update(body).digest('hex')

// ── Pure rules ──────────────────────────────────────────────────────────────

const homes = (town = 'Nairobi') =>
  price(modules.homes, { clientType: 'owner', details: { size: '2br', purpose: 'let' }, addons: { reel: 1 }, location: { town } }, rateTableV1)
const doc = (town?: string) => ({ ...docFromEngine(homes(town), { requestId: 'r', leadId: 'l', version: 1, depositBp: 5000, validUntil: '2026-11-30', status: 'sent' }), id: 'q' })

test('jobs: a quote is payable only when open, final and not yet booked', () => {
  const on = { hasJob: false, paymentsOn: true }
  assert.equal(payBlocker(doc(), 'open', on), null)
  assert.equal(payBlocker(doc(), 'open', { ...on, paymentsOn: false }), 'payments_off')
  assert.equal(payBlocker(doc(), 'open', { ...on, hasJob: true }), 'already_booked')
  assert.equal(payBlocker(doc(), 'expired', on), 'not_open')
  assert.equal(payBlocker(doc('Mombasa'), 'open', on), 'not_final', 'a range or far-travel quote waits for staff')
  const tbc = doc()
  tbc.options[1].lines[0].tbc = true
  assert.equal(payBlocker(tbc, 'open', on), 'not_final')
})

test('jobs: booking days skip days off and full slots, and start after the notice', () => {
  const now = new Date('2026-10-28T09:00:00Z')        // Wednesday in Nairobi
  const days = bookingDays({ ...DEFAULT_BOOKING, noticeDays: 2, horizonDays: 10 }, [{ date: '2026-10-31', window: 'morning', n: 1 }], now)
  assert.equal(days[0].date, '2026-10-30', 'two days notice')
  assert.ok(!days.some(d => d.date === '2026-11-01'), 'Sunday is off')
  assert.equal(slotOpen(days, '2026-10-31', 'morning'), false)
  assert.equal(slotOpen(days, '2026-10-31', 'afternoon'), true)
  assert.equal(slotOpen(days, '2026-10-29', 'morning'), false, 'inside the notice period')
  assert.equal(days.at(-1)!.date, '2026-11-07')
  // Late evening in Nairobi is already the next day
  assert.equal(bookingDays({ ...DEFAULT_BOOKING, noticeDays: 0 }, [], new Date('2026-10-28T22:00:00Z'))[0].date, '2026-10-29')
})

test('jobs: profit and the tracker CSV', () => {
  const hours = { travel: 1.5, shoot: 2, edit: 3.25, admin: 0.25 }
  assert.deepEqual(profit({ price: 15000, costsTotal: 1500, hours }), { hours: 7, profit: 13500, perHour: 1929 })
  assert.equal(profit({ price: 15000, costsTotal: 0, hours: { travel: 0, shoot: 0, edit: 0, admin: 0 } }).perHour, null)
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
  assert.equal(csvCell('+254712'), "'+254712")
  assert.equal(csvCell('Wanjiru, Kilimani'), '"Wanjiru, Kilimani"')
  assert.equal(csvCell(null), '')
  const job = { ref: 'J-ABC123', shootDate: '2026-11-03', leadName: '@Amina', industry: 'homes', clientType: 'owner', source: null, tier: 'standard', status: 'closed',
    price: 15000, depositAmount: 7500, balanceAmount: 7500, balanceStatus: 'paid', hours, costsTotal: 1500, currency: 'KES' } as unknown as JobRecord
  const csv = trackerCsv([job], { industry: k => (k === 'homes' ? 'Homes and real estate' : ''), clientType: k => (k === 'owner' ? 'Owner' : '') })
  const [head, row] = csv.replace('﻿', '').trim().split('\r\n')
  assert.ok(head.startsWith('Job,Shoot date,Client,Industry,Client type,Source,'))
  assert.equal(row, "J-ABC123,2026-11-03,'@Amina,Homes and real estate,Owner,direct,standard,closed,15000,7500,7500,paid,1.5,2,3.25,0.25,7,1500,13500,1929,KES")
})

test('paystack: signatures and the live-key guard', () => {
  const body = '{"event":"charge.success"}'
  assert.equal(signatureValid(body, sign(body), SECRET), true)
  assert.equal(signatureValid(body + ' ', sign(body), SECRET), false)
  assert.equal(signatureValid(body, undefined, SECRET), false)
  assert.equal(signatureValid(body, 'short', SECRET), false)
  const saved = { key: process.env.QUOTE_PAYSTACK_SECRET_KEY, live: process.env.QUOTE_PAYMENTS_LIVE }
  try {
    delete process.env.QUOTE_PAYSTACK_SECRET_KEY
    assert.equal(paystackFromEnv(), null)
    process.env.QUOTE_PAYSTACK_SECRET_KEY = 'sk_live_abc'
    delete process.env.QUOTE_PAYMENTS_LIVE
    assert.throws(() => paystackFromEnv(), /test mode/)
    process.env.QUOTE_PAYSTACK_SECRET_KEY = 'sk_test_abc'
    assert.equal(paystackFromEnv()!.live, false)
  } finally {
    if (saved.key === undefined) delete process.env.QUOTE_PAYSTACK_SECRET_KEY; else process.env.QUOTE_PAYSTACK_SECRET_KEY = saved.key
    if (saved.live === undefined) delete process.env.QUOTE_PAYMENTS_LIVE; else process.env.QUOTE_PAYMENTS_LIVE = saved.live
  }
})

// ── Form to quote to paid job ──────────────────────────────────────────────

const templates = {
  'deposit_paid:email': { version: 1, subject: 'Deposit received: {{amount}}', body: 'Hi {{name}}, {{amount}} for {{option}} ({{quote_ref}}). Balance {{balance}}.' },
  'staff_deposit_paid:email': { version: 1, subject: 'Deposit paid: {{name}}', body: '{{name}} paid {{amount}}. {{admin_link}}' },
  'balance_request:whatsapp': { version: 1, subject: null, body: 'Hi {{name}}, balance {{amount}}: {{pay_link}}' },
}

async function setup(opts: { paymentsOn?: boolean; at?: string } = {}) {
  const store = memoryStore({
    rateTable: rateTableV1, consent: { id: 'c1', body: 'Consent wording' }, templates, recipients: ['staff@example.com'],
    staff: [
      { userId: ADMIN, displayName: 'Peter', role: 'admin', discountLimitBp: 10_000, email: 'peter@example.com', active: true },
      { userId: SALES, displayName: 'Wanjiru', role: 'sales', discountLimitBp: 500, email: null, active: true },
      { userId: VIEWER, displayName: 'Otieno', role: 'viewer', discountLimitBp: 0, email: null, active: true },
    ],
  })
  const desk = memoryDeskStore(() => store.dump())
  const jobs = memoryJobStore(() => store.dump())
  const paystack = fakePaystack()
  let clock = new Date(opts.at ?? '2026-10-28T09:00:00Z')    // Wednesday, 12:00 in Nairobi
  const events: Array<[string, string, Record<string, unknown>]> = []
  const emails: any[] = []
  const tokens: string[] = []
  let n = 0
  const payments = {
    paystack: opts.paymentsOn === false ? null : paystack, publicUrl: 'https://app.example.com', messagesLive: false, now: () => clock,
    track: (id: string, e: string, p: Record<string, unknown>) => { events.push([id, e, p]) },
    sendEmail: async (m: any) => { emails.push(m) },
  }
  const alerts = { liveSend: false, extraRecipients: [], adminUrl: 'https://admin.example.com', send: async () => {} }
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store, desk, jobs, alerts, payments, webhookSecret: SECRET })
  await fastify.register(quoteAdminRoutes, {
    prefix: '/admin/quote', store, desk, jobs, payments, adminStore: memoryAdminStore(() => store.dump()),
    messagesLive: false, publicUrl: 'https://app.example.com', now: () => clock,
    newToken: () => { const t = crypto.createHash('sha256').update(`tok${n++}`).digest('base64url').slice(0, 43); tokens.push(t); return t },
  })
  const call = (method: string, url: string, who = ADMIN, payload?: unknown) =>
    fastify.inject({ method: method as any, url, headers: as(who), ...(payload !== undefined ? { payload: payload as any } : {}) })
  const pub = (method: string, url: string, payload?: unknown) => fastify.inject({ method: method as any, url, ...(payload !== undefined ? { payload: payload as any } : {}) })

  // A visitor fills the form; staff send the form's quote as a link
  async function quoted(o: { email?: string; town?: string } = {}) {
    const start = await pub('POST', '/quote/requests', { moduleKey: 'homes', entry: { source: 'instagram' } })
    const token = start.json().token
    const patch = (payload: object) => pub('PATCH', `/quote/requests/${token}`, payload)
    await patch({ step: 'contact', clientType: 'owner', firstName: 'Amina', whatsapp: `0712 345 6${String(70 + n).slice(-2)}`, email: o.email ?? '', consent: true, consentTextId: 'c1' })
    await patch({ step: 'details', details: { size: '2br', purpose: 'let' } })
    await patch({ step: 'extras', addons: { reel: 1 } })
    await patch({ step: 'where', location: { town: o.town ?? 'Kilimani, Nairobi' }, timing: 'this_month' })
    const quote = store.dump().quotes.at(-1)!
    const sent = await call('POST', `/admin/quote/quotes/${quote.id}/send`, SALES, { channel: 'link' })
    assert.equal(sent.statusCode, 200, sent.body)
    return { quote, token: tokens.at(-1)! }
  }
  return { fastify, store, jobs, paystack, events, emails, call, pub, quoted, setClock: (iso: string) => { clock = new Date(iso) } }
}

test('pay: a test quote is accepted, paid and becomes a job', async () => {
  const t = await setup()
  const { quote, token } = await t.quoted()
  const std = quote.options.find(o => o.tier === 'standard')!

  let page = (await t.pub('GET', `/quote/view/${token}`)).json()
  assert.deepEqual(page.pay, { blocker: null, needsEmail: true })
  assert.equal(page.job, null)

  // No email on the form: Paystack needs one
  const noEmail = await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'standard' })
  assert.equal(noEmail.statusCode, 422)
  assert.equal(noEmail.json().code, 'EMAIL_NEEDED')
  assert.equal((await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'standard', email: 'not-an-email' })).statusCode, 400)

  const start = await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'standard', email: 'Amina@Example.com', amount: 1 })
  assert.equal(start.statusCode, 200, start.body)
  const { reference, authorizationUrl } = start.json()
  assert.match(reference, /^qp_[A-Za-z0-9_-]{24}$/)
  assert.ok(authorizationUrl.includes(reference))
  const tx = t.paystack.transactions.get(reference)!
  assert.equal(tx.amount, std.deposit * 100, 'the amount comes from the stored quote, in cents')
  assert.equal(tx.email, 'amina@example.com')
  assert.deepEqual(tx.channels, ['card', 'mobile_money'])
  assert.equal(tx.callbackUrl, `https://app.example.com/quote/view/${token}`)
  assert.ok(!JSON.stringify(tx.metadata).includes('Amina'), 'no personal data in Paystack metadata')
  assert.equal(t.store.dump().leads[0].email, 'amina@example.com', 'the email is kept for the receipt')
  assert.deepEqual(t.events.at(-1)!.slice(1), ['deposit started', { tier: 'standard', live: false }])

  // Back from Paystack before paying: still waiting
  assert.deepEqual((await t.pub('POST', '/quote/payments/verify', { reference })).json(), { status: 'pending', kind: 'deposit' })
  assert.equal(t.store.dump().jobs.length, 0)

  // Paid by M-Pesa: the return page settles it
  t.paystack.complete(reference, { channel: 'mobile_money' })
  assert.deepEqual((await t.pub('POST', '/quote/payments/verify', { reference })).json(), { status: 'paid', kind: 'deposit' })
  const d = t.store.dump()
  assert.equal(d.jobs.length, 1)
  const job = d.jobs[0]
  assert.equal(job.price, std.total)
  assert.equal(job.depositAmount, std.deposit)
  assert.equal(job.balanceAmount, std.total - std.deposit)
  assert.equal(job.industry, 'homes')
  assert.equal(job.clientType, 'owner')
  assert.equal(job.source, 'instagram')
  assert.equal(d.quotes.find(q => q.id === quote.id)!.status, 'accepted')
  assert.equal(d.leads[0].stage, 'booked')
  assert.equal(d.invoices[0].status, 'not_configured', 'eTIMS hook ran')
  const paid = t.events.filter(e => e[1] === 'deposit paid')
  assert.equal(paid.length, 1)
  assert.deepEqual(paid[0][2], { tier: 'standard', via: 'return', channel: 'mobile_money', live: false })
  assert.ok(!JSON.stringify(t.events).includes('amina'), 'analytics carry no personal data')
  const msgs = d.messages.filter(m => m.templateKey === 'deposit_paid' || m.templateKey === 'staff_deposit_paid')
  assert.deepEqual(msgs.map(m => [m.templateKey, m.status, m.skipReason]), [['staff_deposit_paid', 'skipped', 'sandbox'], ['deposit_paid', 'skipped', 'sandbox']])
  assert.match(msgs[1].renderedBody!, /Standard/)

  // The webhook arrives too (and again): nothing happens twice
  const body = JSON.stringify({ event: 'charge.success', data: { reference } })
  for (let i = 0; i < 2; i++) {
    const hook = await t.pub('POST', '/quote/payments/webhook', undefined)
    assert.equal(hook.statusCode, 401, 'unsigned webhooks are refused')
    const ok = await t.fastify.inject({ method: 'POST', url: '/quote/payments/webhook', headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(body) }, payload: body })
    assert.equal(ok.statusCode, 200)
  }
  assert.equal(t.store.dump().jobs.length, 1)
  assert.equal(t.events.filter(e => e[1] === 'deposit paid').length, 1)
  assert.equal(t.store.dump().invoices.length, 1)

  // The page now shows the booking and no pay button
  page = (await t.pub('GET', `/quote/view/${token}`)).json()
  assert.equal(page.quote.state, 'accepted')
  assert.equal(page.pay.blocker, 'already_booked')
  assert.equal(page.job.depositAmount, std.deposit)
  assert.equal(page.job.shootDateStatus, 'none')
  assert.equal((await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'premium', email: 'a@b.co' })).json().code, 'ALREADY_BOOKED')

  // Pick a day: Sunday is off, the notice period is kept
  const booking = (await t.pub('GET', `/quote/view/${token}/booking`)).json()
  assert.equal(booking.days[0].date, '2026-10-30')
  assert.equal((await t.pub('POST', `/quote/view/${token}/date`, { date: '2026-11-01', window: 'morning' })).json().code, 'SLOT_FULL')
  const picked = await t.pub('POST', `/quote/view/${token}/date`, { date: '2026-11-03', window: 'morning' })
  assert.equal(picked.statusCode, 200, picked.body)
  assert.equal(picked.json().job.shootDateStatus, 'requested')
  // they can change their mind until staff confirm
  assert.equal((await t.pub('POST', `/quote/view/${token}/date`, { date: '2026-11-03', window: 'afternoon' })).statusCode, 200)
})

test('pay: wrong amounts, failures and duplicate deposits', async () => {
  const t = await setup()
  const { quote, token } = await t.quoted({ email: 'amina@example.com' })
  const page = (await t.pub('GET', `/quote/view/${token}`)).json()
  assert.equal(page.pay.needsEmail, false)

  // Paystack reports less than the deposit: nothing is booked
  const a = (await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'standard' })).json()
  const std = quote.options.find(o => o.tier === 'standard')!
  t.paystack.complete(a.reference, { amount: std.deposit * 100 - 100 })
  assert.equal((await t.pub('POST', '/quote/payments/verify', { reference: a.reference })).json().status, 'mismatch')
  assert.equal(t.store.dump().jobs.length, 0)

  // A failed card
  const b = (await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'standard' })).json()
  t.paystack.complete(b.reference, { status: 'failed' })
  assert.equal((await t.pub('POST', '/quote/payments/verify', { reference: b.reference })).json().status, 'failed')

  // Paystack down: nothing charged, the client is told
  t.paystack.failNextInitialize = true
  const down = await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'standard' })
  assert.equal(down.statusCode, 502)
  assert.match(down.json().statusMessage, /Nothing was charged/)

  // Two tabs: both checkouts paid; the second is kept for a refund
  const c = (await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'standard' })).json()
  const e = (await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'premium' })).json()
  t.paystack.complete(c.reference)
  t.paystack.complete(e.reference, { channel: 'card' })
  assert.equal((await t.pub('POST', '/quote/payments/verify', { reference: c.reference })).json().status, 'paid')
  assert.equal((await t.pub('POST', '/quote/payments/verify', { reference: e.reference })).json().status, 'paid')
  const d = t.store.dump()
  assert.equal(d.jobs.length, 1)
  assert.equal(d.jobs[0].tier, 'standard')
  assert.match(d.payments.find(p => p.reference === e.reference)!.note!, /refund/)
  assert.equal(t.events.filter(x => x[1] === 'deposit paid').length, 1)

  // Unknown or malformed references
  assert.equal((await t.pub('POST', '/quote/payments/verify', { reference: 'qp_' + 'x'.repeat(24) })).statusCode, 404)
  assert.equal((await t.pub('POST', '/quote/payments/verify', { reference: 'abc' })).statusCode, 400)
})

test('pay: a range quote waits for staff; payments off hides the button', async () => {
  const t = await setup()
  const { quote, token } = await t.quoted({ email: 'a@example.com' })
  // (staff can't send a quote with "to be confirmed" lines; a range can reach the client)
  t.store.dump().quotes.find(q => q.id === quote.id)!.mode = 'range'
  const page = (await t.pub('GET', `/quote/view/${token}`)).json()
  assert.equal(page.pay.blocker, 'not_final')
  assert.equal((await t.pub('POST', `/quote/view/${token}/pay`, { tier: page.quote.options[0].tier })).json().code, 'NOT_FINAL')

  const off = await setup({ paymentsOn: false })
  const q = await off.quoted({ email: 'a@example.com' })
  assert.equal((await off.pub('GET', `/quote/view/${q.token}`)).json().pay.blocker, 'payments_off')
  assert.equal((await off.pub('POST', `/quote/view/${q.token}/pay`, { tier: 'standard' })).json().code, 'PAYMENTS_OFF')
})

test('pay: the 10-minute check settles payments the webhook missed', async () => {
  const t = await setup()
  const { token } = await t.quoted({ email: 'a@example.com' })
  const a = (await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'essential' })).json()
  t.paystack.complete(a.reference)
  const p = t.store.dump().payments.find(x => x.reference === a.reference)!
  p.createdAt = new Date(Date.now() - 15 * 60_000).toISOString()
  const deps = paymentDeps({ jobs: t.jobs, desk: memoryDeskStore(() => t.store.dump()), store: t.store, log: { info() {}, warn() {}, error() {} } },
    { paystack: t.paystack, track: () => {}, sendEmail: async () => {}, alerts: { liveSend: false, extraRecipients: [], adminUrl: '', send: async () => {} } })
  assert.deepEqual(await recheckPayments(deps), { checked: 1, paid: 1 })
  assert.deepEqual(await recheckPayments(deps), { checked: 0, paid: 0 })
  assert.equal(t.store.dump().jobs[0].tier, 'essential')
})

test('jobs admin: schedule, hours, costs, balance and the tracker', async () => {
  const t = await setup()
  const { token } = await t.quoted({ email: 'amina@example.com' })
  const a = (await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'standard' })).json()
  t.paystack.complete(a.reference)
  await t.pub('POST', '/quote/payments/verify', { reference: a.reference })
  await t.pub('POST', `/quote/view/${token}/date`, { date: '2026-11-03', window: 'morning' })
  const jobId = t.store.dump().jobs[0].id

  const list = await t.call('GET', '/admin/quote/jobs?status=open', VIEWER)
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().rows[0].leadName, 'Amina')
  assert.equal(list.json().rows[0].profit.perHour, null)
  assert.equal((await t.call('GET', '/admin/quote/jobs?status=nope')).statusCode, 400)

  const detail = (await t.call('GET', `/admin/quote/jobs/${jobId}`, SALES)).json()
  assert.equal(detail.job.shootDateStatus, 'requested')
  assert.equal(detail.lead.firstName, 'Amina')
  assert.equal(detail.job.payments.length, 1)

  // Viewers can't change anything; sales can run the job
  assert.equal((await t.call('PATCH', `/admin/quote/jobs/${jobId}`, VIEWER, { status: 'scheduled' })).statusCode, 403)
  assert.equal((await t.call('PATCH', `/admin/quote/jobs/${jobId}`, SALES, { hours: { travel: 1.3 } })).statusCode, 400, 'quarter hours only')
  assert.equal((await t.call('PATCH', `/admin/quote/jobs/${jobId}`, SALES, { price: 1 })).statusCode, 400, 'the price is not editable here')
  const confirm = await t.call('PATCH', `/admin/quote/jobs/${jobId}`, SALES, { shootDateStatus: 'confirmed', status: 'scheduled', assignedStaffId: SALES, hours: { travel: 1.5, shoot: 2 } })
  assert.equal(confirm.statusCode, 200, confirm.body)
  assert.equal(confirm.json().job.assignedStaffName, 'Wanjiru')
  assert.equal((await t.pub('POST', `/quote/view/${token}/date`, { date: '2026-11-04', window: 'morning' })).json().code, 'DATE_LOCKED')

  const cost = (await t.call('POST', `/admin/quote/jobs/${jobId}/costs`, SALES, { label: 'Uber to Kilimani', amount: 1200 })).json().cost
  await t.call('POST', `/admin/quote/jobs/${jobId}/costs`, SALES, { label: 'Parking', amount: 300 })
  assert.equal((await t.call('POST', `/admin/quote/jobs/${jobId}/costs`, SALES, { label: 'x', amount: 12.5 })).statusCode, 400, 'whole shillings')
  assert.equal((await t.call('DELETE', `/admin/quote/jobs/${jobId}/costs/${cost.id}`, SALES)).statusCode, 204)
  const delivered = await t.call('PATCH', `/admin/quote/jobs/${jobId}`, SALES, {
    status: 'delivered', deliveredAt: '2026-11-05T10:00:00.000Z', tourUrl: 'https://app.viewora.software/t/abc', hours: { edit: 3, admin: 0.5 },
  })
  const j = delivered.json().job
  assert.equal(j.costsTotal, 300)
  assert.deepEqual(j.profit, { hours: 7, profit: j.price - 300, perHour: Math.round((j.price - 300) / 7) })
  assert.equal(t.store.dump().leads[0].stage, 'delivered')
  assert.equal((await t.call('PATCH', `/admin/quote/jobs/${jobId}`, SALES, { tourUrl: 'javascript:alert(1)' })).statusCode, 400)

  // Balance link for WhatsApp (sales may send it); marking paid by hand is admin-only
  const link = await t.call('POST', `/admin/quote/jobs/${jobId}/balance-link`, SALES)
  assert.equal(link.statusCode, 200, link.body)
  assert.match(decodeURIComponent(link.json().waUrl), new RegExp(`balance KES ${j.balanceAmount.toLocaleString('en-KE')}`))
  const balanceTx = [...t.paystack.transactions.values()].at(-1)!
  assert.equal(balanceTx.amount, j.balanceAmount * 100)
  assert.equal(balanceTx.callbackUrl, 'https://app.example.com/quote/paid')
  assert.equal((await t.call('POST', `/admin/quote/jobs/${jobId}/balance`, SALES, { channel: 'mpesa' })).statusCode, 403)
  const manual = await t.call('POST', `/admin/quote/jobs/${jobId}/balance`, ADMIN, { channel: 'mpesa', reference: 'QK12AB34', note: 'Till' })
  assert.equal(manual.statusCode, 200, manual.body)
  assert.equal(manual.json().job.balanceStatus, 'paid')
  assert.equal(t.store.dump().leads[0].stage, 'paid')
  assert.equal((await t.call('POST', `/admin/quote/jobs/${jobId}/balance`, ADMIN, { channel: 'cash' })).json().code, 'BALANCE_CLOSED')
  // The Paystack link paid afterwards is kept for a refund
  t.paystack.complete(balanceTx.reference)
  assert.equal((await t.pub('POST', '/quote/payments/verify', { reference: balanceTx.reference })).json().status, 'paid')
  assert.match(t.store.dump().payments.find(p => p.reference === balanceTx.reference)!.note!, /refund/)

  await t.call('PATCH', `/admin/quote/jobs/${jobId}`, ADMIN, { status: 'closed' })
  assert.equal((await t.call('GET', '/admin/quote/jobs-export', SALES)).statusCode, 403)
  const csv = await t.call('GET', '/admin/quote/jobs-export', ADMIN)
  assert.equal(csv.statusCode, 200)
  assert.match(String(csv.headers['content-type']), /text\/csv/)
  const lines = csv.body.replace('﻿', '').trim().split('\r\n')
  assert.equal(lines.length, 2)
  assert.match(lines[1], /,Amina,Homes and real estate,Owner,instagram,standard,closed,/)

  // Booking settings: admins only
  assert.equal((await t.call('PUT', '/admin/quote/booking-settings', SALES, { ...DEFAULT_BOOKING, perSlot: 2 })).statusCode, 403)
  assert.equal((await t.call('PUT', '/admin/quote/booking-settings', ADMIN, { ...DEFAULT_BOOKING, noticeDays: 50, horizonDays: 40 })).statusCode, 400)
  const s = await t.call('PUT', '/admin/quote/booking-settings', ADMIN, { ...DEFAULT_BOOKING, perSlot: 2, daysOff: [6, 0, 0] })
  assert.deepEqual(s.json().settings.daysOff, [0, 6])
  assert.ok(t.store.dump().audit.some(x => x.entityType === 'settings'))
})

test('jobs admin: balance link respects quiet hours and opt-out', async () => {
  const t = await setup()
  const { token } = await t.quoted({ email: 'amina@example.com' })
  const a = (await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'standard' })).json()
  t.paystack.complete(a.reference)
  await t.pub('POST', '/quote/payments/verify', { reference: a.reference })
  const jobId = t.store.dump().jobs[0].id
  t.setClock('2026-10-28T19:30:00Z')     // 22:30 in Nairobi
  assert.equal((await t.call('POST', `/admin/quote/jobs/${jobId}/balance-link`, SALES)).json().code, 'QUIET_HOURS')
  t.setClock('2026-10-29T09:00:00Z')
  t.store.dump().leads[0].optedOutAt = '2026-10-29T08:00:00Z'
  assert.equal((await t.call('POST', `/admin/quote/jobs/${jobId}/balance-link`, SALES)).json().code, 'OPTED_OUT')
})

test('invoicing: the eTIMS hook marks invoices it cannot issue yet', async () => {
  const t = await setup()
  const { token } = await t.quoted({ email: 'amina@example.com' })
  const a = (await t.pub('POST', `/quote/view/${token}/pay`, { tier: 'standard' })).json()
  t.paystack.complete(a.reference)
  await t.pub('POST', '/quote/payments/verify', { reference: a.reference })
  const d = t.store.dump()
  const inv = d.invoices[0]
  const log = { info() {}, error() {} }
  assert.equal(await issueInvoice(t.jobs, log, { invoiceId: inv.id, jobId: inv.jobId, paymentId: inv.paymentId }, {
    name: 'test-etims', issue: async ({ payment }) => ({ externalRef: `KRA-${payment.amount}` }),
  }), 'issued')
  assert.equal(d.invoices[0].externalRef, `KRA-${d.jobs[0].depositAmount}`)
  assert.equal(await issueInvoice(t.jobs, log, { invoiceId: inv.id, jobId: inv.jobId, paymentId: inv.paymentId }, {
    name: 'test-etims', issue: async () => { throw new Error('KRA down') },
  }), 'failed')
  assert.equal(d.invoices[0].error, 'KRA down')
})
