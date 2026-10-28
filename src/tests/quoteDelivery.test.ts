import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'

import quoteRoutes from '../routes/quote.js'
import quoteAdminRoutes from '../routes/quoteAdmin.js'
import { memoryStore } from '../quote/store.js'
import { memoryAdminStore } from '../quote/adminStore.js'
import { memoryDeskStore } from '../quote/deskStore.js'
import { memoryJobStore } from '../quote/jobStore.js'
import { memoryFollowupStore } from '../quote/followupStore.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'

process.env.ADMIN_SECRET = 'test-admin-secret'
const ADMIN = '00000000-0000-4000-8000-000000000001'
const SALES = '00000000-0000-4000-8000-000000000002'
const VIEWER = '00000000-0000-4000-8000-000000000003'
const STUDIO = '00000000-0000-4000-8000-0000000000a1'
const PETER = '11111111-1111-4111-8111-111111111111'
const AMINA = '22222222-2222-4222-8222-222222222222'
const GUEST = '33333333-3333-4333-8333-333333333333'
const TOUR = '44444444-4444-4444-8444-444444444444'
const OTHER_TOUR = '55555555-5555-4555-8555-555555555555'

async function fakeAuth(request: FastifyRequest, reply: FastifyReply) {
  const m = /^Bearer user:([0-9a-f-]{36})$/.exec(String(request.headers.authorization ?? ''))
  if (!m) return reply.code(401).send({ code: 'UNAUTHORIZED' })
  request.user = { sub: m[1], is_anonymous: m[1] === GUEST }
}

async function setup(at = '2026-11-02T09:00:00Z') {
  let time = new Date(at)
  const now = () => time
  const store = memoryStore({
    rateTable: rateTableV1, consent: { id: 'c1', body: 'Consent wording' }, recipients: [], clock: now,
    templates: { 'tour_delivery:whatsapp': { version: 1, subject: null, body: 'Hi {{name}}, open {{delivery_link}} by {{expires_on}}' } },
    staff: [
      { userId: ADMIN, displayName: 'Admin', role: 'admin', discountLimitBp: 10_000, email: null, active: true },
      { userId: SALES, displayName: 'Wanjiru', role: 'sales', discountLimitBp: 500, email: null, active: true },
      { userId: VIEWER, displayName: 'Viewer', role: 'viewer', discountLimitBp: 0, email: null, active: true },
    ],
    tours: [
      { id: TOUR, userId: STUDIO, title: 'Kilimani 2-bedroom', slug: 'kilimani', coverUrl: null, isPublished: true, updatedAt: at, storageBytes: 1000 },
      { id: OTHER_TOUR, userId: AMINA, title: 'Not the studio', slug: null, coverUrl: null, isPublished: true, updatedAt: at, storageBytes: 5 },
    ],
  })
  const desk = memoryDeskStore(() => store.dump())
  const jobs = memoryJobStore(() => store.dump())
  const followups = memoryFollowupStore(() => store.dump())
  const alerts = { liveSend: false, extraRecipients: [], adminUrl: 'https://admin.example.com', send: async () => {} }
  const messaging = { now, publicUrl: 'https://app.example.com', optOutSecret: 'optout-test', messagesLive: false }
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store, desk, jobs, alerts, followups, messaging, authenticate: fakeAuth, payments: { paystack: null, now } })
  await fastify.register(quoteAdminRoutes, {
    prefix: '/admin/quote', store, desk, jobs, followups, adminStore: memoryAdminStore(() => store.dump()),
    messagesLive: false, publicUrl: 'https://app.example.com', now, payments: { paystack: null, now }, studioUserId: STUDIO,
  })
  const inject = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
    fastify.inject({ method: method as any, url, headers, ...(payload !== undefined ? { payload: payload as any } : {}) })
  const staff = (who: string) => (method: string, url: string, payload?: unknown) =>
    inject(method, url, { authorization: 'Bearer test-admin-secret', 'x-admin-id': who }, payload)
  const client = (user: string | null) => (method: string, url: string, payload?: unknown) =>
    inject(method, url, user ? { authorization: `Bearer user:${user}` } : {}, payload)

  // A finished form, a staff quote, and a paid job for it
  const pub = client(null)
  const { token } = (await pub('POST', '/quote/requests', { moduleKey: 'homes' })).json()
  await pub('PATCH', `/quote/requests/${token}`, { step: 'contact', clientType: 'owner', firstName: 'Peter', whatsapp: '0712 345 678', consent: true, consentTextId: 'c1' })
  await pub('PATCH', `/quote/requests/${token}`, { step: 'details', details: { size: '2br', purpose: 'let' } })
  const lead = store.dump().leads[0]
  const quote = await staff(SALES)('POST', `/admin/quote/leads/${lead.id}/quotes`, {})
  assert.ok([200, 201].includes(quote.statusCode), quote.body)
  const jobId = crypto.randomUUID()
  store.dump().jobs.push({
    id: jobId, ref: 'J-0001', quoteId: quote.json().id, leadId: lead.id, optionTier: 'standard', tier: 'standard', status: 'delivered',
    price: 6000, currency: 'KES', depositAmount: 3000, depositStatus: 'paid', depositPaidAt: at, balanceAmount: 3000, balanceStatus: 'pending',
    balancePaidAt: null, shootDate: null, shootWindow: null, shootDateStatus: 'none', locationText: null, locationLat: null, locationLng: null,
    assignedStaffId: null, hours: { travel: 0, shoot: 0, edit: 0, admin: 0 }, deliveredAt: null, tourUrl: null, notes: null,
    industry: 'homes', clientType: 'owner', createdAt: at,
  } as any)
  const owner = (id = TOUR) => store.dump().deliveries.tours.find(t => t.id === id)!.userId
  const move = (days: number) => { time = new Date(time.getTime() + days * 86_400_000) }
  return { store, staff, client, jobId, leadId: lead.id, owner, move }
}

const tokenOf = (url: string) => url.split('/deliver/')[1]

test('delivery: staff send a link; the tour moves only when the client accepts it', async () => {
  const t = await setup()
  const tours = (await t.staff(SALES)('GET', '/admin/quote/studio-tours')).json().tours
  assert.deepEqual(tours.map((x: any) => x.id), [TOUR], 'only tours in the studio account')

  const res = await t.staff(SALES)('POST', `/admin/quote/jobs/${t.jobId}/deliveries`, { propertyId: TOUR })
  assert.equal(res.statusCode, 201, res.body)
  const { url, waUrl, delivery } = res.json()
  assert.match(url, /^https:\/\/app\.example\.com\/deliver\/[A-Za-z0-9_-]{43}$/)
  assert.ok(decodeURIComponent(waUrl).includes(url), 'the WhatsApp text carries the link')
  assert.equal(delivery.status, 'pending')
  assert.equal(t.owner(), STUDIO, 'nothing moves when the link is made')
  const row = t.store.dump().deliveries.rows[0]
  assert.ok(!JSON.stringify(row).includes(tokenOf(url)), 'only the hash is stored')
  assert.equal(t.store.dump().messages.at(-1)!.templateKey, 'tour_delivery')

  const peter = t.client(PETER)
  assert.equal((await t.client(null)('GET', `/quote/account/deliveries/${tokenOf(url)}`)).statusCode, 401)
  assert.equal((await t.client(GUEST)('POST', `/quote/account/deliveries/${tokenOf(url)}/accept`)).statusCode, 403, 'a guest session cannot take a tour')
  const seen = (await peter('GET', `/quote/account/deliveries/${tokenOf(url)}`)).json()
  assert.deepEqual([seen.status, seen.tour.title], ['pending', 'Kilimani 2-bedroom'])
  assert.equal(t.owner(), STUDIO, 'looking does not move it')

  const accepted = await peter('POST', `/quote/account/deliveries/${tokenOf(url)}/accept`)
  assert.equal(accepted.statusCode, 200, accepted.body)
  assert.equal(accepted.json().status, 'accepted')
  assert.equal(t.owner(), PETER)
  assert.deepEqual(t.store.dump().deliveries.usage[PETER], { activeProperties: 1, storageBytes: 1000 })
  assert.deepEqual(t.store.dump().deliveries.usage[STUDIO], { activeProperties: 0, storageBytes: 0 })
  assert.equal(t.store.dump().leads[0].userId, PETER, 'the lead is tied to the account that took the tour')
  assert.ok(t.store.dump().audit.some(a => a.action === 'tour_delivered' && a.entityId === t.jobId))

  // Accepting again is harmless; anyone else gets the same "link gone"
  assert.equal((await peter('POST', `/quote/account/deliveries/${tokenOf(url)}/accept`)).json().status, 'accepted')
  assert.equal((await t.client(AMINA)('POST', `/quote/account/deliveries/${tokenOf(url)}/accept`)).json().code, 'LINK_GONE')
  assert.equal(t.owner(), PETER)
})

test('delivery: a lead tied to one account cannot be taken by another', async () => {
  const t = await setup()
  t.store.dump().leads[0].userId = PETER
  const { url } = (await t.staff(SALES)('POST', `/admin/quote/jobs/${t.jobId}/deliveries`, { propertyId: TOUR })).json()
  assert.equal((await t.client(AMINA)('POST', `/quote/account/deliveries/${tokenOf(url)}/accept`)).json().code, 'OTHER_ACCOUNT')
  assert.equal(t.owner(), STUDIO)
})

test('delivery: links expire, can be stopped, and a new link stops the old one', async () => {
  const t = await setup()
  const make = async () => (await t.staff(SALES)('POST', `/admin/quote/jobs/${t.jobId}/deliveries`, { propertyId: TOUR })).json()
  const first = await make()
  const second = await make()
  assert.equal((await t.client(PETER)('GET', `/quote/account/deliveries/${tokenOf(first.url)}`)).json().code, 'LINK_GONE', 'the older link stopped')
  assert.equal((await t.staff(SALES)('POST', `/admin/quote/deliveries/${second.delivery.id}/revoke`)).statusCode, 200)
  assert.equal((await t.client(PETER)('POST', `/quote/account/deliveries/${tokenOf(second.url)}/accept`)).json().code, 'LINK_GONE')
  const third = await make()
  t.move(31)
  assert.equal((await t.client(PETER)('POST', `/quote/account/deliveries/${tokenOf(third.url)}/accept`)).json().code, 'LINK_GONE', 'expired after 30 days')
  assert.equal(t.owner(), STUDIO)
  // Nonsense tokens look the same as used ones
  assert.equal((await t.client(PETER)('GET', `/quote/account/deliveries/${'x'.repeat(43)}`)).json().code, 'LINK_GONE')
})

test('delivery: only studio tours, only the right roles, and an admin can undo', async () => {
  const t = await setup()
  assert.equal((await t.staff(SALES)('POST', `/admin/quote/jobs/${t.jobId}/deliveries`, { propertyId: OTHER_TOUR })).json().code, 'NOT_STUDIO_TOUR')
  assert.equal((await t.staff(VIEWER)('POST', `/admin/quote/jobs/${t.jobId}/deliveries`, { propertyId: TOUR })).statusCode, 403)
  assert.equal((await t.staff(VIEWER)('GET', '/admin/quote/studio-tours')).statusCode, 403)
  const { url, delivery } = (await t.staff(SALES)('POST', `/admin/quote/jobs/${t.jobId}/deliveries`, { propertyId: TOUR })).json()
  await t.client(PETER)('POST', `/quote/account/deliveries/${tokenOf(url)}/accept`)
  assert.equal((await t.staff(SALES)('POST', `/admin/quote/deliveries/${delivery.id}/undo`, { reason: 'Wrong client' })).statusCode, 403, 'undo is admin-only')
  assert.equal((await t.staff(ADMIN)('POST', `/admin/quote/deliveries/${delivery.id}/undo`, {})).statusCode, 400, 'a reason is required')
  const undone = await t.staff(ADMIN)('POST', `/admin/quote/deliveries/${delivery.id}/undo`, { reason: 'Wrong client' })
  assert.equal(undone.json().delivery.status, 'undone')
  assert.equal(t.owner(), STUDIO)
  assert.deepEqual(t.store.dump().deliveries.usage[PETER], { activeProperties: 0, storageBytes: 0 })
  assert.ok(t.store.dump().audit.some(a => a.action === 'tour_delivery_undone' && a.actorId === ADMIN && a.reason === 'Wrong client'))
  assert.equal((await t.staff(ADMIN)('POST', `/admin/quote/deliveries/${delivery.id}/undo`, { reason: 'again' })).json().code, 'NOT_ACCEPTED')
  const list = (await t.staff(VIEWER)('GET', `/admin/quote/jobs/${t.jobId}/deliveries`)).json()
  assert.deepEqual([list.studioReady, list.deliveries.map((d: any) => d.status)], [true, ['undone']])
})

test('delivery: no WhatsApp text in quiet hours or for an opted-out client; the link still works', async () => {
  const t = await setup('2026-11-02T19:30:00Z')   // 22:30 in Nairobi
  const night = (await t.staff(SALES)('POST', `/admin/quote/jobs/${t.jobId}/deliveries`, { propertyId: TOUR })).json()
  assert.equal(night.waUrl, null)
  assert.match(night.waBlocked, /07:00/)
  const t2 = await setup()
  t2.store.dump().leads[0].optedOutAt = '2026-11-01T00:00:00Z'
  const out = (await t2.staff(SALES)('POST', `/admin/quote/jobs/${t2.jobId}/deliveries`, { propertyId: TOUR })).json()
  assert.equal(out.waUrl, null)
  assert.match(out.waBlocked, /not to be contacted/)
  assert.equal((await t2.client(PETER)('POST', `/quote/account/deliveries/${tokenOf(out.url)}/accept`)).json().status, 'accepted')
})
