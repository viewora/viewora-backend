import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'

import quoteRoutes from '../routes/quote.js'
import quoteStaffAppRoutes from '../routes/quoteStaffApp.js'
import { memoryStore } from '../quote/store.js'
import { memoryDeskStore } from '../quote/deskStore.js'
import { memoryJobStore } from '../quote/jobStore.js'
import { memoryFollowupStore } from '../quote/followupStore.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'

const ADMIN = '00000000-0000-4000-8000-000000000001'      // is_admin, qe_staff admin
const SALES = '00000000-0000-4000-8000-000000000002'      // is_admin, qe_staff sales
const BARE_ADMIN = '00000000-0000-4000-8000-000000000003' // is_admin, no qe_staff row
const CUSTOMER = '00000000-0000-4000-8000-000000000004'   // an ordinary app user

// Stands in for the auth plugin: the bearer token is the user id
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const h = request.headers.authorization
  if (!h?.startsWith('Bearer ')) { reply.code(401).send({ code: 'UNAUTHORIZED' }); return }
  const id = h.slice(7)
  request.user = { id, sub: id, is_anonymous: id === 'anon' }
}

async function setup() {
  const now = () => new Date('2026-11-19T09:00:00Z')
  const store = memoryStore({
    rateTable: rateTableV1, consent: { id: 'c1', body: 'Consent wording' }, recipients: [], clock: now,
    staff: [
      { userId: ADMIN, displayName: 'Peter', role: 'admin', discountLimitBp: 10_000, email: null, active: true },
      { userId: SALES, displayName: 'Wanjiru', role: 'sales', discountLimitBp: 500, email: null, active: true },
    ],
  })
  const desk = memoryDeskStore(() => store.dump())
  const fastify = Fastify()
  await fastify.register(quoteRoutes, {
    prefix: '/quote', store, desk, jobs: memoryJobStore(() => store.dump()),
    alerts: { liveSend: false, extraRecipients: [], adminUrl: 'https://admin.example.com', send: async () => {} },
    followups: memoryFollowupStore(() => store.dump()),
    messaging: { now, publicUrl: 'https://app.example.com', optOutSecret: 'optout-test', messagesLive: false },
    payments: { paystack: null, now },
  })
  await fastify.register(quoteStaffAppRoutes, {
    prefix: '/staff/quote', store, desk, now, publicUrl: 'https://app.example.com', authenticate,
    isAdmin: async id => [ADMIN, SALES, BARE_ADMIN].includes(id),
  })
  const call = (method: string, url: string, who: string | null, payload?: unknown) => fastify.inject({
    method: method as any, url,
    headers: who ? { authorization: `Bearer ${who}` } : {},
    ...(payload !== undefined ? { payload: payload as any } : {}),
  })
  // A partner fills the form for one of their clients
  async function fillFor(partnerCode: string, phone: string, name: string) {
    const res = await fastify.inject({ method: 'POST', url: '/quote/requests', payload: { moduleKey: 'homes', entry: { partnerCode } } })
    assert.equal(res.statusCode, 201)
    const contact = await fastify.inject({
      method: 'PATCH', url: `/quote/requests/${res.json().token}`,
      payload: { step: 'contact', clientType: 'owner', firstName: name, whatsapp: phone, email: '', consent: true, consentTextId: 'c1' },
    })
    assert.equal(contact.statusCode, 200)
  }
  return { store, call, fillFor }
}

test('staff app: needs a session, and the session must belong to an admin', async () => {
  const t = await setup()
  assert.equal((await t.call('GET', '/staff/quote/partners', null)).statusCode, 401)
  assert.equal((await t.call('GET', '/staff/quote/partners', CUSTOMER)).statusCode, 403)
  assert.equal((await t.call('GET', '/staff/quote/partners', 'anon')).statusCode, 403)
  // The sidebar's check answers everyone signed in, without saying more than "not staff"
  const probe = await t.call('GET', '/staff/quote/me', CUSTOMER)
  assert.deepEqual([probe.statusCode, probe.json()], [200, { role: null, displayName: null }])
  assert.equal((await t.call('GET', '/staff/quote/me', null)).statusCode, 401)
  assert.equal((await t.call('GET', '/staff/quote/commission', CUSTOMER)).statusCode, 403)
  assert.equal((await t.call('POST', '/staff/quote/partners', CUSTOMER, { name: 'X', code: 'XX', commissionType: 'percent', commissionValue: 1000 })).statusCode, 403)
  assert.equal(t.store.dump().partners.length, 0)
})

test('staff app: roles come from qe_staff, as on /admin/quote', async () => {
  const t = await setup()
  assert.deepEqual((await t.call('GET', '/staff/quote/me', ADMIN)).json(), { role: 'admin', displayName: 'Peter' })
  assert.deepEqual((await t.call('GET', '/staff/quote/me', BARE_ADMIN)).json(), { role: 'viewer', displayName: null })
  const body = { name: 'Douglas', code: 'DOUGLAS', commissionType: 'percent', commissionValue: 1000 }
  // Sales and an admin without a staff row can see partners but not set terms or see money
  assert.equal((await t.call('POST', '/staff/quote/partners', SALES, body)).statusCode, 403)
  assert.equal((await t.call('POST', '/staff/quote/partners', BARE_ADMIN, body)).statusCode, 403)
  assert.equal((await t.call('GET', '/staff/quote/commission', SALES)).statusCode, 403)
  assert.equal((await t.call('GET', '/staff/quote/partners', SALES)).statusCode, 200)
})

test('staff app: a partner made here is credited for each client they quote for', async () => {
  const t = await setup()
  const made = await t.call('POST', '/staff/quote/partners', ADMIN, { name: 'Douglas', code: 'douglas', commissionType: 'percent', commissionValue: 1000 })
  assert.equal(made.statusCode, 201)
  assert.equal(made.json().partner.code, 'DOUGLAS')

  await t.fillFor('DOUGLAS', '0712 000 001', 'Achieng')
  await t.fillFor('DOUGLAS', '0712 000 002', 'Baraka')
  await t.fillFor('DOUGLAS', '0712 000 003', 'Chebet')
  // The same client again is still one lead
  await t.fillFor('DOUGLAS', '0712 000 003', 'Chebet')

  const list = (await t.call('GET', '/staff/quote/partners', ADMIN)).json()
  assert.equal(list.formUrl, 'https://app.example.com/quote')
  assert.equal(list.partners.find((p: any) => p.code === 'DOUGLAS').leads, 3)

  const report = await t.call('GET', '/staff/quote/commission', ADMIN)
  assert.equal(report.statusCode, 200)
  assert.deepEqual(report.json().rows, [], 'no jobs yet, so nothing is owed')
  const csv = await t.call('GET', '/staff/quote/commission.csv', ADMIN)
  assert.equal(csv.statusCode, 200)
  assert.match(csv.headers['content-type'] as string, /text\/csv/)
})
