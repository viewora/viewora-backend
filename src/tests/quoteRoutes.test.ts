import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import quoteRoutes from '../routes/quote.js'
import { memoryStore } from '../quote/store.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'

const consent = { id: 'consent-1', body: 'Viewora can send me my quote and follow-ups on WhatsApp and email.' }

async function app() {
  const store = memoryStore({ rateTable: rateTableV1, consent })
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store })
  return { fastify, store }
}

async function start(fastify: any, body: Record<string, unknown> = { moduleKey: 'homes', clientType: 'owner', entry: { source: 'instagram' } }) {
  const res = await fastify.inject({ method: 'POST', url: '/quote/requests', payload: body })
  return { res, token: res.json().token as string }
}

const patch = (fastify: any, token: string, payload: Record<string, unknown>) =>
  fastify.inject({ method: 'PATCH', url: `/quote/requests/${token}`, payload })

const contact = { step: 'contact', firstName: 'Amina', whatsapp: '0712 345 678', email: 'amina@example.com', consent: true, consentTextId: 'consent-1' }

test('quote API: config lists enabled modules with rate-table prices and consent wording', async () => {
  const { fastify } = await app()
  const res = await fastify.inject({ method: 'GET', url: '/quote/config' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(body.modules.map((m: any) => m.key), ['homes', 'airbnb', 'hotels', 'vehicles', 'restaurants', 'developers', 'malls', 'institutions', 'farms', 'wayfinding', 'floorplans', 'other'])
  const homes = body.modules[0]
  assert.equal(homes.from, 4500)
  assert.equal(homes.questions[0].options.find((o: any) => o.value === '2br').price, 7000)
  assert.equal(homes.questions[0].options.find((o: any) => o.value === 'estate').price, null, 'custom sizes show no price')
  assert.equal(homes.questions[0].options[0].rateKey, undefined, 'rate keys stay on the server')
  assert.equal(body.modules.find((m: any) => m.key === 'other').from, null)
  // Land has no minimum: a plot shows its rate card price
  const dev = body.modules.find((m: any) => m.key === 'developers')
  assert.equal(dev.from, 3500)
  assert.equal(dev.questions.find((q: any) => q.id === 'land_size').options[0].price, 3500)
  assert.equal(dev.questions.find((q: any) => q.id === 'land_size').options[0].noMinimum, undefined, 'only value, label and price go out')
  // Elsewhere a shown price never sits below the minimum job price
  const malls = body.modules.find((m: any) => m.key === 'malls')
  assert.equal(malls.from, 7000, 'a popup is from 5,000 but quotes no less than the 7,000 business minimum')
  assert.deepEqual(body.consent, consent)
  const rush = homes.addons.find((a: any) => a.key === 'rush')
  assert.deepEqual([rush.amount, rush.percentBp], [null, 3000], 'percentage add-ons are not shown as shillings')
})

test('quote API: full form → instant price, lead saved, quote stored', async () => {
  const { fastify, store } = await app()
  const { res, token } = await start(fastify)
  assert.equal(res.statusCode, 201)
  assert.match(token, /^[A-Za-z0-9_-]{32}$/)

  assert.equal((await patch(fastify, token, contact)).statusCode, 200)
  assert.equal((await patch(fastify, token, { step: 'details', details: { size: '2br', purpose: 'let' } })).statusCode, 200)
  assert.equal((await patch(fastify, token, { step: 'extras', addons: { photos_20: 1 } })).statusCode, 200)
  const done = await patch(fastify, token, { step: 'where', location: { town: 'Kilimani, Nairobi' }, timing: 'this_month' })
  assert.equal(done.statusCode, 200)
  const { request, result } = done.json()
  assert.equal(request.stepReached, 5)
  assert.equal(request.completed, true)
  assert.equal(result.mode, 'instant')
  assert.deepEqual(result.options.map((o: any) => [o.tier, o.total]), [['essential', 7000], ['standard', 11000], ['premium', 27000]])

  const data = store.dump() as any
  assert.equal(data.leads.length, 1)
  assert.equal(data.leads[0].whatsappE164, '+254712345678')
  assert.equal(data.leads[0].consentTextId, 'consent-1')
  assert.equal(data.leads[0].source, 'instagram')
  assert.equal(data.quotes.length, 1)
})

test('quote API: resume link returns saved answers, contact and result', async () => {
  const { fastify } = await app()
  const { token } = await start(fastify)
  await patch(fastify, token, contact)
  await patch(fastify, token, { step: 'details', details: { size: 'studio', purpose: 'let' } })
  const res = await fastify.inject({ method: 'GET', url: `/quote/requests/${token}` })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.request.stepReached, 3)
  assert.equal(body.request.answers.details.size, 'studio')
  assert.deepEqual(body.contact, { firstName: 'Amina', whatsapp: '+254712345678', email: 'amina@example.com' })
  assert.equal(body.result, null)
})

test('quote API: abandoned after step 2 still leaves a saved lead', async () => {
  const { fastify, store } = await app()
  const { token } = await start(fastify)
  await patch(fastify, token, contact)
  const data = store.dump() as any
  assert.equal(data.leads.length, 1)
  assert.equal(data.requests[0].stepReached, 2)
  assert.equal(data.requests[0].completedAt, null)
})

test('quote API: Other never shows the visitor a price', async () => {
  const { fastify, store } = await app()
  const { token } = await start(fastify, { moduleKey: 'other', clientType: 'manager' })
  await patch(fastify, token, contact)
  await patch(fastify, token, { step: 'details', details: { description: 'Church hall and grounds', areas: 12 } })
  await patch(fastify, token, { step: 'extras', addons: {} })
  const done = await patch(fastify, token, { step: 'where', location: { town: 'Thika' }, timing: 'planning' })
  const { result, request } = done.json()
  assert.equal(result.mode, 'custom')
  assert.deepEqual(result.options, [])
  // 12 areas × 800 + Greater Nairobi travel (Thika) 2,000
  assert.equal((store.dump() as any).quotes[0].trace.options[0].total, 12 * 800 + 2000, 'staff still get the draft')
  assert.equal((store.dump() as any).requests[0].flags.includes('new_industry'), true)
  assert.equal(request.completed, true)
})

test('quote API: friendly phone errors and server-side validation', async () => {
  const { fastify } = await app()
  const { token } = await start(fastify)
  const bad = await patch(fastify, token, { ...contact, whatsapp: '07123' })
  assert.equal(bad.statusCode, 400)
  assert.deepEqual(bad.json().fields, [{ field: 'whatsapp', message: 'too_short' }])
  const badChoice = await patch(fastify, token, { step: 'details', details: { size: 'castle' } })
  assert.equal(badChoice.statusCode, 400)
  assert.deepEqual(badChoice.json().fields, [{ field: 'size', code: 'invalid_option' }])
  const notOffered = await patch(fastify, token, { step: 'extras', addons: { airbnb_pro_pack: 1 } })
  assert.equal(notOffered.statusCode, 400)
})

test('quote API: unknown answer keys are dropped', async () => {
  const { fastify } = await app()
  const { token } = await start(fastify)
  const res = await patch(fastify, token, { step: 'details', details: { size: '1br', purpose: 'let', price: 1 } })
  assert.deepEqual(res.json().request.answers.details, { size: '1br', purpose: 'let' })
})

test('quote API: the last step needs contact details first', async () => {
  const { fastify } = await app()
  const { token } = await start(fastify)
  await patch(fastify, token, { step: 'details', details: { size: '1br', purpose: 'let' } })
  const res = await patch(fastify, token, { step: 'where', location: { town: 'Nairobi' }, timing: 'this_week' })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().code, 'CONTACT_REQUIRED')
})

test('quote API: changing industry clears the old industry details', async () => {
  const { fastify } = await app()
  const { token } = await start(fastify)
  await patch(fastify, token, { step: 'details', details: { size: '1br', purpose: 'let' } })
  const res = await patch(fastify, token, { step: 'industry', moduleKey: 'hotels', clientType: 'manager' })
  assert.deepEqual(res.json().request.answers.details, {})
})

test('quote API: honeypot submissions look accepted but store nothing', async () => {
  const { fastify, store } = await app()
  const { res } = await start(fastify, { moduleKey: 'homes', website: 'http://spam.example' })
  assert.equal(res.statusCode, 201)
  assert.equal((store.dump() as any).requests.length, 0)
})

test('quote API: bad and unknown tokens are rejected', async () => {
  const { fastify } = await app()
  assert.equal((await fastify.inject({ method: 'GET', url: '/quote/requests/short' })).statusCode, 400)
  assert.equal((await fastify.inject({ method: 'GET', url: `/quote/requests/${'a'.repeat(32)}` })).statusCode, 404)
})

test('quote API: unknown industries cannot be started', async () => {
  const { fastify } = await app()
  const { res } = await start(fastify, { moduleKey: 'castle' })
  assert.equal(res.statusCode, 400)
})

test('quote API: no published rate table gives an honest 503', async () => {
  const store = memoryStore({ rateTable: rateTableV1 })
  store.publishedRateTable = async () => null
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store })
  const res = await fastify.inject({ method: 'GET', url: '/quote/config' })
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().code, 'NO_RATE_TABLE')
})

test('quote API: preview gives the running total before travel and stores nothing', async () => {
  const { fastify, store } = await app()
  const res = await fastify.inject({ method: 'POST', url: '/quote/preview', payload: { moduleKey: 'homes', clientType: 'owner', details: { size: '2br', purpose: 'let' }, addons: { photos_20: 1 } } })
  assert.equal(res.statusCode, 200)
  // Standard option for the same answers in the full-form test is 11,000 (Kilimani, in Nairobi zone)
  assert.equal(res.json().beforeTravel, 11000)
  const custom = await fastify.inject({ method: 'POST', url: '/quote/preview', payload: { moduleKey: 'other', details: { description: 'Hall', areas: 4 }, addons: {} } })
  assert.equal(custom.json().beforeTravel, null, 'custom quotes never show a price')
  assert.equal((store.dump() as any).requests.length, 0)
})

test('quote API: planned industries go to staff pricing, tagged; who-you-are can come with contact', async () => {
  const { fastify, store } = await app()
  const { token } = await start(fastify, { moduleKey: 'other', industryHint: 'restaurants' })
  assert.deepEqual((store.dump() as any).requests[0].flags, ['industry:restaurants'])
  await patch(fastify, token, { ...contact, clientType: 'other' })
  assert.equal((store.dump() as any).requests[0].clientType, 'other')
  await patch(fastify, token, { step: 'industry', moduleKey: 'other', industryHint: 'farms' })
  assert.deepEqual((store.dump() as any).requests[0].flags, ['industry:farms'])
})

test('quote API: vehicles are priced', async () => {
  const { fastify } = await app()
  const { token } = await start(fastify, { moduleKey: 'vehicles' })
  await patch(fastify, token, contact)
  await patch(fastify, token, { step: 'details', details: { kind: 'showroom', showroom_size: '10', vehicles: 0 } })
  await patch(fastify, token, { step: 'extras', addons: {} })
  const done = await patch(fastify, token, { step: 'where', location: { town: 'Westlands, Nairobi' }, timing: 'this_month' })
  assert.equal(done.statusCode, 200)
  assert.ok(done.json().result.options.length >= 1)
})
