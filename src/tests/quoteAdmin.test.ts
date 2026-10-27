import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import quoteRoutes from '../routes/quote.js'
import quoteAdminRoutes from '../routes/quoteAdmin.js'
import { memoryStore } from '../quote/store.js'
import { memoryAdminStore } from '../quote/adminStore.js'
import { alertNewLead, render, type AlertConfig } from '../quote/alerts.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'

process.env.ADMIN_SECRET = 'test-admin-secret'
const AUTH = { authorization: 'Bearer test-admin-secret', 'x-admin-id': '00000000-0000-4000-8000-000000000001' }
const SALES = '00000000-0000-4000-8000-000000000002'

const template = {
  version: 1,
  subject: 'New quote lead: {{name}}, {{industry}}',
  body: 'Name: {{name}}\nIndustry: {{industry}}\nWho: {{client_type}}\nSource: {{source}}\nOpen: {{admin_link}}',
}
const silentLog = { info() {}, warn() {}, error() {} }

function alertConfig(over: Partial<AlertConfig> = {}) {
  const sent: Array<{ to: string[]; subject: string; text: string }> = []
  const config: AlertConfig = {
    liveSend: false, extraRecipients: ['team@example.com'], adminUrl: 'https://admin.example.com',
    send: async m => { sent.push(m) }, retryDelaysMs: [0, 0], sleep: async () => {}, ...over,
  }
  return { config, sent }
}

async function setup(alertsOver: Partial<AlertConfig> = {}, templates: Record<string, typeof template> = { 'staff_new_lead:email': template }) {
  const store = memoryStore({ rateTable: rateTableV1, consent: { id: 'c1', body: 'Consent wording' }, templates })
  const { config, sent } = alertConfig(alertsOver)
  const pending: Array<Promise<unknown>> = []
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store, alerts: config, onAlert: p => pending.push(p) })
  await fastify.register(quoteAdminRoutes, { prefix: '/admin/quote', store, adminStore: memoryAdminStore(() => store.dump(), { [SALES]: 'sales' }) })
  return { fastify, store, sent, settle: () => Promise.all(pending) }
}

async function fillForm(fastify: any, opts: { moduleKey?: string; hint?: string; name: string; phone: string; source?: string; finish?: boolean; clientType?: string }) {
  const start = await fastify.inject({
    method: 'POST', url: '/quote/requests',
    payload: { moduleKey: opts.moduleKey ?? 'homes', ...(opts.hint ? { industryHint: opts.hint } : {}), entry: { source: opts.source ?? 'instagram' } },
  })
  const token = start.json().token
  const patch = (payload: object) => fastify.inject({ method: 'PATCH', url: `/quote/requests/${token}`, payload })
  await patch({ step: 'contact', clientType: opts.clientType ?? 'owner', firstName: opts.name, whatsapp: opts.phone, consent: true, consentTextId: 'c1' })
  if (opts.finish) {
    await patch({ step: 'details', details: { size: '2br', purpose: 'let' } })
    await patch({ step: 'extras', addons: {} })
    await patch({ step: 'where', location: { town: 'Kilimani, Nairobi' }, timing: 'this_month' })
  }
  return token
}

const get = (fastify: any, url: string, headers: Record<string, string> = AUTH) => fastify.inject({ method: 'GET', url, headers })

// ── Alerts ──────────────────────────────────────────────────────────────

test('alerts: template placeholders render, unknown ones go blank', () => {
  assert.equal(render('Hi {{name}}, {{ industry }} {{nope}}!', { name: 'Amina', industry: 'Homes' }), 'Hi Amina, Homes !')
})

test('alerts: sandbox by default records what would be sent, sends nothing', async () => {
  const { fastify, store, sent, settle } = await setup()
  await fillForm(fastify, { name: 'Amina', phone: '0712 345 678' })
  await settle()
  assert.equal(sent.length, 0)
  const [m] = store.dump().messages
  assert.equal(m.status, 'skipped')
  assert.equal(m.skipReason, 'sandbox')
  assert.match(m.renderedBody!, /Name: Amina\nIndustry: Homes\nWho: Owner\nSource: instagram\nOpen: https:\/\/admin\.example\.com\/dashboard\/quotes\//)
})

test('alerts: live send goes to staff once per new lead, not for a returning number', async () => {
  const { fastify, store, sent, settle } = await setup({ liveSend: true })
  await fillForm(fastify, { name: 'Otieno', phone: '0722 000 111', moduleKey: 'other', hint: 'restaurants', clientType: 'marketer' })
  await fillForm(fastify, { name: 'Otieno', phone: '0722 000 111' })
  await settle()
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].to, ['team@example.com'])
  assert.equal(sent[0].subject, 'New quote lead: Otieno, Restaurants and venues')
  assert.match(sent[0].text, /Who: Marketing agency/)
  assert.equal(store.dump().messages[0].status, 'sent')
})

test('alerts: a failing provider is retried, then recorded as failed; the lead is still saved', async () => {
  let calls = 0
  const { fastify, store, settle } = await setup({ liveSend: true, send: async () => { calls++; throw new Error('provider down') } })
  const token = await fillForm(fastify, { name: 'Amina', phone: '0712 345 678' })
  await settle()
  assert.equal(calls, 3, 'first try plus two retries')
  const data = store.dump()
  assert.equal(data.leads.length, 1)
  assert.equal(data.messages[0].status, 'failed')
  assert.equal(data.messages[0].error, 'provider down')
  // and the visitor carries on
  const resume = await fastify.inject({ method: 'GET', url: `/quote/requests/${token}` })
  assert.equal(resume.json().request.stepReached, 2)
})

test('alerts: no recipients or no template are recorded, never thrown', async () => {
  const none = await setup({ liveSend: true, extraRecipients: [] })
  await fillForm(none.fastify, { name: 'A', phone: '0712 345 678' })
  await none.settle()
  assert.equal(none.store.dump().messages[0].skipReason, 'no_recipients')

  const noTemplate = await setup({ liveSend: true }, {})
  const res = await noTemplate.fastify.inject({ method: 'POST', url: '/quote/requests', payload: { moduleKey: 'homes' } })
  const contact = await noTemplate.fastify.inject({
    method: 'PATCH', url: `/quote/requests/${res.json().token}`,
    payload: { step: 'contact', firstName: 'B', whatsapp: '0712 345 679', consent: false },
  })
  assert.equal(contact.statusCode, 200)
  await noTemplate.settle()
  assert.equal(noTemplate.store.dump().messages[0].error, 'template_missing')
})

test('alerts: opted-in staff and the env list are merged without duplicates', async () => {
  const store = memoryStore({ rateTable: rateTableV1, templates: { 'staff_new_lead:email': template }, recipients: ['Team@example.com', 'peter@example.com'] })
  const { config, sent } = alertConfig({ liveSend: true })
  const outcome = await alertNewLead(store, config, silentLog, { leadId: 'l1', firstName: 'A', industry: 'Homes', clientType: 'Owner', source: null })
  assert.equal(outcome, 'sent')
  assert.deepEqual(sent[0].to, ['team@example.com', 'peter@example.com'])
  assert.match(sent[0].text, /Source: direct/)
})

// ── Admin routes ────────────────────────────────────────────────────────

test('admin: wrong secret, missing staff id and bad ids are refused', async () => {
  const { fastify } = await setup()
  assert.equal((await get(fastify, '/admin/quote/leads', {})).statusCode, 401)
  assert.equal((await get(fastify, '/admin/quote/leads', { authorization: 'Bearer nope', 'x-admin-id': AUTH['x-admin-id'] })).statusCode, 401)
  assert.equal((await get(fastify, '/admin/quote/leads', { authorization: AUTH.authorization })).statusCode, 401)
  assert.equal((await get(fastify, '/admin/quote/leads', { ...AUTH, 'x-admin-id': 'not-a-uuid' })).statusCode, 401)
  assert.equal((await get(fastify, '/admin/quote/leads/not-a-uuid')).statusCode, 400)
  assert.equal((await get(fastify, '/admin/quote/leads/00000000-0000-4000-8000-00000000dead')).statusCode, 404)
  assert.equal((await get(fastify, '/admin/quote/leads?stage=bogus')).statusCode, 400)
  assert.equal((await get(fastify, '/admin/quote/leads?limit=1000')).statusCode, 400)
})

test('admin: lead list shows each lead once with industry, step and price, newest first', async () => {
  const { fastify, settle } = await setup()
  await fillForm(fastify, { name: 'Amina', phone: '0712 345 678', finish: true })
  await fillForm(fastify, { name: 'Otieno', phone: '0722 000 111', moduleKey: 'other', hint: 'restaurants', source: 'tiktok' })
  await settle()
  const res = await get(fastify, '/admin/quote/leads')
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.total, 2)
  assert.deepEqual(body.rows.map((r: any) => r.firstName), ['Otieno', 'Amina'])
  const amina = body.rows[1]
  assert.equal(amina.industry, 'homes')
  assert.equal(amina.stepReached, 5)
  assert.equal(amina.completed, true)
  assert.equal(amina.total, 7000, "standard option of 2br, to let, Nairobi, no extras")
  assert.equal(body.rows[0].industry, 'restaurants')
  assert.equal(body.rows[0].total, null)
})

test('admin: filters and search', async () => {
  const { fastify, settle } = await setup()
  await fillForm(fastify, { name: 'Amina', phone: '0712 345 678', finish: true })
  await fillForm(fastify, { name: 'Otieno', phone: '0722 000 111', moduleKey: 'other', hint: 'farms', source: 'tiktok' })
  await settle()
  const total = async (qs: string) => (await get(fastify, `/admin/quote/leads?${qs}`)).json().total
  assert.equal(await total('status=completed'), 1)
  assert.equal(await total('status=abandoned'), 1)
  assert.equal(await total('industry=farms'), 1)
  assert.equal(await total('source=tiktok'), 1)
  assert.equal(await total('stage=new'), 2)
  assert.equal(await total('q=ami'), 1)
  assert.equal(await total('q=0722'), 1, 'local number format finds the +254 number')
  assert.equal(await total('q=zzz'), 0)
  const page2 = (await get(fastify, '/admin/quote/leads?limit=1&page=2')).json()
  assert.equal(page2.rows.length, 1)
  assert.equal(page2.page, 2)
})

test('admin: lead page has answers, consent, quote lines and the alert log', async () => {
  const { fastify, settle } = await setup()
  await fillForm(fastify, { name: 'Amina', phone: '0712 345 678', finish: true })
  await settle()
  const id = (await get(fastify, '/admin/quote/leads')).json().rows[0].leadId
  const res = await get(fastify, `/admin/quote/leads/${id}`)
  assert.equal(res.statusCode, 200)
  const d = res.json()
  assert.equal(d.lead.whatsapp, '+254712345678')
  assert.equal(d.lead.consentWhatsapp, true)
  assert.ok(d.lead.consentAt)
  assert.equal(d.requests[0].answers.details.size, '2br')
  assert.equal(d.requests[0].answers.location.town, 'Kilimani, Nairobi')
  assert.deepEqual(d.requests[0].quotes[0].options.map((o: any) => o.tier), ['essential', 'standard', 'premium'])
  assert.ok(d.requests[0].quotes[0].options[0].lines.length > 0)
  assert.equal(d.messages[0].skipReason, 'sandbox')
  const view = Object.fromEntries(d.requests[0].answersView.map((r: any) => [r.label, r.value]))
  assert.equal(view['Industry'], 'Homes')
  assert.equal(view['Who they are'], 'Owner')
  assert.equal(view['What size is the home?'], '2 bedrooms')
  assert.equal(view['Where'], 'Kilimani, Nairobi')
  assert.equal(view['When'], 'This month')
})

test('admin: summary counts and filter choices, with the staff role', async () => {
  const { fastify, settle } = await setup()
  await fillForm(fastify, { name: 'Amina', phone: '0712 345 678', finish: true })
  await fillForm(fastify, { name: 'Otieno', phone: '0722 000 111', moduleKey: 'other', hint: 'farms', source: 'tiktok' })
  await fastify.inject({ method: 'POST', url: '/quote/requests', payload: { moduleKey: 'hotels' } })   // left at step 1
  await settle()
  const s = (await get(fastify, '/admin/quote/summary')).json()
  assert.equal(s.role, 'viewer', 'an admin without a staff row reads as viewer')
  assert.equal(s.newToday, 2)
  assert.equal(s.leads7d, 2)
  assert.equal(s.completed7d, 1)
  assert.equal(s.noContact7d, 1)
  assert.deepEqual(s.abandonedByStep, { 1: 1, 2: 1 })
  assert.deepEqual(s.sources, ['instagram', 'tiktok'])
  assert.deepEqual(s.industries, ['farms', 'homes'])
  const sales = (await get(fastify, '/admin/quote/summary', { ...AUTH, 'x-admin-id': SALES })).json()
  assert.equal(sales.role, 'sales')
})
