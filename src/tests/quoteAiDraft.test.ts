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
import { catalogue, draftPrompt, readDraft, redact } from '../quote/aiDraft.js'

process.env.ADMIN_SECRET = 'test-admin-secret'
const SALES = '00000000-0000-4000-8000-000000000002'
const as = (who: string) => ({ authorization: 'Bearer test-admin-secret', 'x-admin-id': who })

// ── Pure rules ──────────────────────────────────────────────────────────────

test('ai draft: phone numbers and emails never leave in the description', () => {
  assert.equal(redact('Dental clinic, call me on 0712 345 678 or +254 712 345 678, amina@example.com'),
    'Dental clinic, call me on [number] or [number], [email]')
  assert.equal(redact('Two floors, 12 rooms'), 'Two floors, 12 rooms', 'small numbers stay')
})

test('ai draft: only rate table items with a published price can be picked', () => {
  const keys = catalogue(rateTableV1).map(c => c.key)
  assert.ok(keys.includes('scene_business'))
  assert.ok(!keys.includes('home_estate'), 'custom items are staff-priced')
  assert.ok(!keys.includes('sale_uplift'), 'percentages are not lines')
  assert.ok(!keys.includes('min_business'), 'minimums are applied by the engine')
})

test('ai draft: the answer is read as keys and quantities; prices come from the table', () => {
  const raw = JSON.stringify({
    lines: [
      { key: 'scene_business', qty: 12, reason: 'Twelve rooms', unit: 1 },
      { key: 'scene_business', qty: 3 },          // duplicate
      { key: 'made_up', qty: 1 },                 // not in the table
      { key: 'home_estate', qty: 1 },             // custom: staff price it
      { key: 'video_walkthrough', qty: 0 },       // bad quantity
    ],
    questions: ['Is the second floor open to the public?'],
  })
  const d = readDraft(raw, rateTableV1)
  const scene = rateTableV1.items.scene_business
  assert.deepEqual(d.lines.map(l => [l.key, l.qty, l.unit, l.amount, l.kind]), [['scene_business', 12, scene.low, scene.low! * 12, 'per_unit']])
  assert.equal(d.lines[0].note, 'AI suggestion: Twelve rooms')
  assert.equal(d.dropped, 4)
  assert.deepEqual(d.questions, ['Is the second floor open to the public?'])
  assert.deepEqual(readDraft('not json', rateTableV1), { lines: [], questions: [], dropped: 0 })
  assert.equal(readDraft('```json\n{"lines":[{"key":"scene_business","qty":2}]}\n```', rateTableV1).lines.length, 1)
})

test('ai draft: the prompt carries the catalogue and the description, nothing else', () => {
  const p = draftPrompt({ description: 'A church hall', setting: 'indoors', areas: 4, floors: 1 }, rateTableV1)
  assert.match(p.system, /scene_business \| 360° scene \| per scene/)
  assert.doesNotMatch(p.system, /\d{3,},|KES/, 'no prices are shown to the model')
  assert.equal(p.user, 'What the client wants shot: A church hall\nIndoors or outdoors: indoors\nRooms or areas: 4\nFloors: 1')
})

// ── Route ───────────────────────────────────────────────────────────────────

async function setup(aiDraft: ((p: { system: string; user: string }) => Promise<string>) | null) {
  const now = () => new Date('2026-11-02T09:00:00Z')
  const store = memoryStore({
    rateTable: rateTableV1, consent: { id: 'c1', body: 'Consent wording' }, recipients: [], clock: now,
    staff: [{ userId: SALES, displayName: 'Wanjiru', role: 'sales', discountLimitBp: 500, email: null, active: true }],
  })
  const desk = memoryDeskStore(() => store.dump())
  const jobs = memoryJobStore(() => store.dump())
  const followups = memoryFollowupStore(() => store.dump())
  const alerts = { liveSend: false, extraRecipients: [], adminUrl: 'https://admin.example.com', send: async () => {} }
  const messaging = { now, publicUrl: 'https://app.example.com', optOutSecret: 'optout-test', messagesLive: false }
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store, desk, jobs, alerts, followups, messaging, payments: { paystack: null, now } })
  await fastify.register(quoteAdminRoutes, {
    prefix: '/admin/quote', store, desk, jobs, followups, adminStore: memoryAdminStore(() => store.dump()), aiDraft,
    messagesLive: false, publicUrl: 'https://app.example.com', now, payments: { paystack: null, now },
  })
  const pub = (method: string, url: string, payload?: unknown) => fastify.inject({ method: method as any, url, ...(payload ? { payload: payload as any } : {}) })
  const call = (method: string, url: string, payload?: unknown) => fastify.inject({ method: method as any, url, headers: as(SALES), ...(payload ? { payload: payload as any } : {}) })
  // A finished form, then a staff draft quote for it
  async function quoteFor(moduleKey: string, details: Record<string, unknown>) {
    const { token } = (await pub('POST', '/quote/requests', { moduleKey })).json()
    await pub('PATCH', `/quote/requests/${token}`, { step: 'contact', clientType: 'owner', firstName: 'Amina', whatsapp: '0712 345 678', email: 'amina@example.com', consent: true, consentTextId: 'c1' })
    await pub('PATCH', `/quote/requests/${token}`, { step: 'details', details })
    await pub('PATCH', `/quote/requests/${token}`, { step: 'extras', addons: {} })
    await pub('PATCH', `/quote/requests/${token}`, { step: 'where', location: { town: 'Karen, Nairobi' }, timing: 'this_month' })
    const lead = store.dump().leads[0]
    const res = await call('POST', `/admin/quote/leads/${lead.id}/quotes`, {})
    assert.ok([200, 201].includes(res.statusCode), res.body)
    return res.json().id as string
  }
  return { call, quoteFor, store }
}

test('ai draft route: staff get suggestions; nothing personal is sent and nothing is saved', async () => {
  const sent: string[] = []
  const t = await setup(async p => { sent.push(p.system + p.user); return JSON.stringify({ lines: [{ key: 'scene_business', qty: 8, reason: 'Eight areas' }], questions: [] }) })
  const id = await t.quoteFor('other', { description: 'A church hall and garden, ring 0712 345 678', setting: 'indoors', areas: 8, floors: 1, link: 'https://maps.example.com/amina-home' })
  const before = JSON.stringify(t.store.dump().quotes)
  const res = await t.call('POST', `/admin/quote/quotes/${id}/ai-draft`)
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().lines.map((l: any) => [l.key, l.qty]), [['scene_business', 8]])
  for (const secret of ['Amina', '0712', 'amina@example.com', 'maps.example.com', 'Karen']) assert.ok(!sent[0].includes(secret), `${secret} not sent`)
  assert.equal(JSON.stringify(t.store.dump().quotes), before, 'the quote is unchanged until staff save it')
})

test('ai draft route: only for "Something else", and says so when AI is off or fails', async () => {
  const t = await setup(async () => { throw new Error('quota') })
  const home = await t.quoteFor('homes', { size: '2br', purpose: 'let' })
  assert.equal((await t.call('POST', `/admin/quote/quotes/${home}/ai-draft`)).json().code, 'NOT_OTHER')
  const t2 = await setup(async () => { throw new Error('quota') })
  const other = await t2.quoteFor('other', { description: 'A boat', setting: 'outdoors', areas: 3, floors: 1 })
  assert.deepEqual([(await t2.call('POST', `/admin/quote/quotes/${other}/ai-draft`)).statusCode], [502])
  const off = await setup(null)
  const o = await off.quoteFor('other', { description: 'A boat', setting: 'outdoors', areas: 3, floors: 1 })
  assert.equal((await off.call('POST', `/admin/quote/quotes/${o}/ai-draft`)).json().code, 'AI_OFF')
})
