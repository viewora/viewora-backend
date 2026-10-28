import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'

import quoteRoutes from '../routes/quote.js'
import { memoryStore } from '../quote/store.js'
import { memoryDeskStore } from '../quote/deskStore.js'
import { memoryJobStore } from '../quote/jobStore.js'
import { memoryFollowupStore } from '../quote/followupStore.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'

const PETER = '11111111-1111-4111-8111-111111111111'
const AMINA = '22222222-2222-4222-8222-222222222222'
const GUEST = '33333333-3333-4333-8333-333333333333'

// Stands in for the app's Supabase check: "Bearer user:<id>"
async function fakeAuth(request: FastifyRequest, reply: FastifyReply) {
  const m = /^Bearer user:([0-9a-f-]{36})$/.exec(String(request.headers.authorization ?? ''))
  if (!m) return reply.code(401).send({ code: 'UNAUTHORIZED' })
  request.user = { sub: m[1], is_anonymous: m[1] === GUEST }
}

async function setup() {
  const now = () => new Date('2026-11-02T09:00:00Z')
  const store = memoryStore({
    rateTable: rateTableV1, consent: { id: 'c1', body: 'Consent wording' }, recipients: [], clock: now,
    profiles: {
      [PETER]: { fullName: 'Peter Musis', phone: '0712 345 678', email: 'peter@example.com' },
      [AMINA]: { fullName: null, phone: null, email: 'amina@example.com' },
    },
  })
  const desk = memoryDeskStore(() => store.dump())
  const jobs = memoryJobStore(() => store.dump())
  const followups = memoryFollowupStore(() => store.dump())
  const alerts = { liveSend: false, extraRecipients: [], adminUrl: 'https://admin.example.com', send: async () => {} }
  const messaging = { now, publicUrl: 'https://app.example.com', optOutSecret: 'optout-test', messagesLive: false }
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store, desk, jobs, alerts, followups, messaging, authenticate: fakeAuth, payments: { paystack: null, now } })
  const as = (user: string | null) => (user ? { authorization: `Bearer user:${user}` } : {})
  const call = (method: string, url: string, user: string | null, payload?: unknown) =>
    fastify.inject({ method: method as any, url, headers: as(user), ...(payload !== undefined ? { payload: payload as any } : {}) })
  const start = async (user: string | null) => {
    const res = await call('POST', '/quote/requests', null, { moduleKey: 'homes' })
    const token = res.json().token as string
    if (user) assert.equal((await call('POST', `/quote/account/requests/${token}/claim`, user)).statusCode, 200)
    return token
  }
  return { store, call, start }
}

test('account: first order fills the contact step from the profile; consent is still theirs to give', async () => {
  const t = await setup()
  assert.equal((await t.call('GET', '/quote/account/me', null)).statusCode, 401)
  assert.equal((await t.call('GET', '/quote/account/me', GUEST)).statusCode, 403, 'a guest session uses the public form')

  const me = (await t.call('GET', '/quote/account/me', PETER)).json()
  assert.deepEqual(me.prefill, { firstName: 'Peter', whatsapp: '+254712345678', email: 'peter@example.com' })
  assert.equal(me.onFile, null)
  assert.deepEqual(me.orders, [])

  const token = await t.start(PETER)
  assert.equal(t.store.dump().requests[0].entry.source, 'app')
  // Nothing on file yet: the skip is refused and the visitor sees the contact step
  assert.equal((await t.call('POST', `/quote/account/requests/${token}/contact`, PETER)).json().code, 'CONTACT_NEEDED')
  await t.call('PATCH', `/quote/requests/${token}`, null, { step: 'contact', clientType: 'owner', firstName: 'Peter', whatsapp: '0712 345 678', email: 'peter@example.com', consent: true, consentTextId: 'c1' })
  const lead = t.store.dump().leads[0]
  assert.deepEqual([lead.userId, lead.source, lead.consentWhatsapp], [PETER, 'app', true])
  assert.ok(t.store.dump().audit.some(a => a.action === 'account_linked' && a.entityId === lead.id))
})

test('account: a returning client skips the contact step, keeps one lead, and sees their orders', async () => {
  const t = await setup()
  const first = await t.start(PETER)
  await t.call('PATCH', `/quote/requests/${first}`, null, { step: 'contact', clientType: 'owner', firstName: 'Peter', whatsapp: '0712 345 678', email: '', consent: true, consentTextId: 'c1' })

  const me = (await t.call('GET', '/quote/account/me', PETER)).json()
  assert.deepEqual(me.onFile, { firstName: 'Peter', whatsapp: '+254712345678', email: null })

  const second = await t.start(PETER)
  const res = await t.call('POST', `/quote/account/requests/${second}/contact`, PETER)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().request.stepReached, 2)
  assert.equal(t.store.dump().leads.length, 1, 'same lead, same consent')
  const [r1, r2] = t.store.dump().requests
  assert.equal(r2.leadId, r1.leadId)
  assert.equal((await t.call('GET', '/quote/account/me', PETER)).json().orders.length, 2)

  // Opting out ends the shortcut
  t.store.dump().leads[0].optedOutAt = '2026-11-02T10:00:00Z'
  assert.equal((await t.call('GET', '/quote/account/me', PETER)).json().onFile, null)
})

test('account: a request is only ever one account\'s, and public forms cannot be claimed later', async () => {
  const t = await setup()
  const token = await t.start(PETER)
  assert.equal((await t.call('POST', `/quote/account/requests/${token}/claim`, AMINA)).statusCode, 409)
  assert.equal((await t.call('POST', `/quote/account/requests/${token}/contact`, AMINA)).json().code, 'NOT_YOURS')

  // Someone fills the public form; a signed-in user cannot take it afterwards
  const pub = await t.start(null)
  await t.call('PATCH', `/quote/requests/${pub}`, null, { step: 'contact', clientType: 'owner', firstName: 'Otieno', whatsapp: '0712 345 679', email: '', consent: true, consentTextId: 'c1' })
  assert.equal((await t.call('POST', `/quote/account/requests/${pub}/claim`, AMINA)).json().code, 'ALREADY_STARTED')
  assert.equal(t.store.dump().leads.find(l => l.firstName === 'Otieno')!.userId, undefined)

  // A lead already in another account stays there
  const amina = await t.start(AMINA)
  await t.call('PATCH', `/quote/requests/${amina}`, null, { step: 'contact', clientType: 'owner', firstName: 'Peter', whatsapp: '0712 345 678', email: '', consent: true, consentTextId: 'c1' })
  const p = await t.start(PETER)
  await t.call('PATCH', `/quote/requests/${p}`, null, { step: 'contact', clientType: 'owner', firstName: 'Peter', whatsapp: '0712 345 678', email: '', consent: true, consentTextId: 'c1' })
  assert.equal(t.store.dump().leads.find(l => l.whatsappE164 === '+254712345678')!.userId, AMINA)
  assert.equal((await t.call('GET', '/quote/account/requests/nope/claim', PETER)).statusCode, 404)
})
