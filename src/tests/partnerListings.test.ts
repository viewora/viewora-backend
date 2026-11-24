import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Fastify from 'fastify'
import partnerApi from '../routes/partnerApi.js'
import { generatePartnerKey } from '../utils/partnerKeys.js'
import type { AgentRow, KeyRecord, Partner, PartnerStore, SpaceSummary, TourRefRow } from '../partners/store.js'
import type { GatewayError, TourGateway } from '../partners/tourGateway.js'
import { memoryListingStore } from '../partners/memoryListingStore.js'
import { contactDetailsInText, decide, parseListingId, type ListingService } from '../partners/listingService.js'
import { tick, type JobDeps } from '../partners/jobs.js'
import { SafeFetchError, isPrivateAddress, checkUrlShape, type SafeFetch } from '../partners/safeFetch.js'
import { decryptSecret, encryptSecret, nextAttemptDelayMs, signPayload, verifySignature, MAX_ATTEMPTS } from '../partners/webhooks.js'
import { effectiveScopes, hasScope } from '../partners/scopes.js'
import { buildOpenApi, buildPostman } from '../partners/openapi.js'
import partnerListingAdmin from '../routes/partnerListingAdmin.js'

// ── a small world: two partners, agents, fake tours, fake internet ──────────

const KEY = randomBytes(32)

function world() {
  let t = Date.parse('2026-12-01T08:00:00Z')
  const clock = () => t
  const advance = (ms: number) => { t += ms }

  const partners: Record<string, Partner> = {
    pa: { id: 'pa', slug: 'acme', name: 'Acme Homes', status: 'active', allowed_embed_origins: [], daily_upload_cap: 1000, agent_plan_id: null, paid_until: null, max_agents: null, max_live_listings: 2000 },
    pb: { id: 'pb', slug: 'other', name: 'Other Co', status: 'active', allowed_embed_origins: [], daily_upload_cap: 1000, agent_plan_id: null, paid_until: null, max_agents: null },
  }
  const keys = new Map<string, KeyRecord>()
  const issue = (pid: string, mode: 'test' | 'live' = 'test', extra: Partial<KeyRecord> = {}) => {
    const k = generatePartnerKey(mode)
    keys.set(k.hash, { keyId: `k-${keys.size}`, mode, revoked: false, partner: partners[pid], ...extra })
    return k.key
  }
  let n = 0
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const agents: AgentRow[] = []
  const refs: TourRefRow[] = []
  for (const pid of ['pa', 'pb']) for (const mode of ['test', 'live'] as const) {
    agents.push({ id: uuid(), partner_id: pid, mode, external_id: 'agent-1', user_id: uuid(), name: 'Agent', created_at: 'now' })
  }

  // Fake tours (the dashboard routes): publish needs at least one file.
  const spaces = new Map<string, SpaceSummary & { owner: string; files: Record<string, number>; facts: any }>()
  const tourCalls: string[] = []
  let publishError: string | null = null
  const tours: TourGateway = {
    async createSpace(userId, facts) {
      const id = uuid()
      spaces.set(id, { id, title: facts.title, slug: null, property_type: facts.space_type, is_published: false, cover_image_url: null,
        has_360: false, has_gallery: false, created_at: 'now', updated_at: 'now', owner: userId, files: {}, facts })
      tourCalls.push(`create ${id}`)
      return { ok: true, id }
    },
    async updateSpace(_u, id, facts) { const s = spaces.get(id)!; s.facts = facts; s.title = facts.title; tourCalls.push(`update ${id}`); return { ok: true } },
    async deleteSpace(_u, id) { spaces.delete(id) },
    async setCarIdentity(_u, id) { tourCalls.push(`car ${id}`); return { ok: true } },
    async setPublished(_u, id, publish) {
      const s = spaces.get(id)!
      if (publish && publishError) return { ok: false, status: 400, code: 'BAD_REQUEST', message: publishError } as GatewayError
      if (publish && !Object.values(s.files).some(Boolean)) return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'Add a 360° scene, a photo, an exterior car photo or an aerial plot map before publishing.' } as GatewayError
      s.is_published = publish
      if (publish && !s.slug) s.slug = `tour-${id.slice(-4)}`
      tourCalls.push(`${publish ? 'publish' : 'unpublish'} ${id}`)
      return { ok: true }
    },
    async uploadFile(_u, id, f) {
      const s = spaces.get(id)!
      s.files[f.kind] = (s.files[f.kind] ?? 0) + 1
      return { ok: true, mediaId: uuid(), viewId: f.kind === 'car_exterior' ? uuid() : null }
    },
    async removeMedia() { tourCalls.push('remove-media') },
  }

  const store: PartnerStore = {
    findKeyByHash: async h => keys.get(h) ?? null,
    touchKey: async () => {},
    getPartner: async id => partners[id] ?? null,
    getAgent: async (pid, mode, ext) => agents.find(a => a.partner_id === pid && a.mode === mode && a.external_id === ext) ?? null,
    getAgentsByIds: async ids => agents.filter(a => ids.includes(a.id)),
    listAgents: async (pid, mode) => agents.filter(a => a.partner_id === pid && a.mode === mode),
    countAgents: async () => 0,
    syncAgentPlan: async () => {},
    insertAgent: async () => 'duplicate',
    createAuthUser: async () => ({ error: 'failed' }),
    deleteAuthUser: async () => {},
    getTourRef: async (pid, mode, by) => refs.find(r => r.partner_id === pid && r.mode === mode &&
      (by.id ? r.id === by.id : by.spaceId ? r.space_id === by.spaceId : r.external_id === by.externalId)) ?? null,
    listTourRefs: async () => [],
    insertTourRef: async row => {
      if (refs.some(r => r.partner_id === row.partner_id && r.mode === row.mode && r.external_id === row.external_id)) return 'duplicate'
      const r = { ...row, id: uuid(), created_at: 'now' }
      refs.push(r)
      return r
    },
    deleteTourRef: async () => {},
    getSpaces: async ids => ids.flatMap(i => spaces.get(i) ?? []),
    sceneExists: async () => false,
    vehicleViewExists: async () => false,
  }

  const memWorld: Parameters<typeof memoryListingStore>[0] = {
    refs: () => refs,
    partnerNames: { pa: 'Acme Homes', pb: 'Other Co' },
    mediaCounts: id => ({ photo: spaces.get(id)?.files.photo ?? 0, panorama: spaces.get(id)?.files.panorama ?? 0, tour: 0, car_exterior: spaces.get(id)?.files.car_exterior ?? 0 }),
  }
  const listings = memoryListingStore(memWorld, clock)

  // The internet: image URLs answer with a JPEG unless told otherwise.
  const web = new Map<string, { status: number; type?: string; body?: Buffer; throws?: SafeFetchError }>()
  const sent: { url: string; headers: Record<string, string>; body: string }[] = []
  let hookStatus = 200
  const fetch: SafeFetch = async (url, o = {}) => {
    if (o.method === 'POST') {
      sent.push({ url, headers: o.headers ?? {}, body: String(o.body) })
      return { status: hookStatus, headers: {}, body: Buffer.alloc(0) }
    }
    const r = web.get(url)
    if (r?.throws) throw r.throws
    return { status: r?.status ?? 200, headers: { 'content-type': r?.type ?? 'image/jpeg' }, body: r?.body ?? Buffer.from(`jpeg:${url}`) }
  }

  let service!: ListingService
  async function app() {
    const a = Fastify()
    a.decorate('redis', null)
    await a.register(partnerApi, {
      prefix: '/v1', store, appUrl: 'https://app.test', mediaBaseUrl: 'https://media.test',
      listingsEnabled: true, listings, tours, jobs: false, now: clock,
      checkHost: async (url: string) => { if (url.includes('192.168.')) throw new SafeFetchError('URL_PRIVATE_NETWORK', 'private') },
      webhookKey: () => KEY,
      exposeService: (s: ListingService) => { service = s },
    })
    return a
  }
  const jobDeps = (): JobDeps => ({ listings, partners: store, service, tours, fetch, webhookKey: () => KEY, now: clock })
  const runJobs = async (times = 3) => { for (let i = 0; i < times; i++) await tick(jobDeps(), { sweeps: true }) }

  return {
    app, issue, clock, advance, partners, memWorld, store, agents, refs, spaces, listings, tourCalls, web, sent, runJobs, jobDeps,
    service: () => service,
    setPublishError: (m: string | null) => { publishError = m },
    setHookStatus: (s: number) => { hookStatus = s },
  }
}

const auth = (key: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra })
const photos = (id: string, n = 3) => Array.from({ length: n }, (_, i) => ({ kind: 'photo', source_url: `https://cdn.acme.co.ke/${id}/${i}.jpg` }))
const rental = (id = 'HSE-0042', extra: Record<string, unknown> = {}) => ({
  external_id: id, agent_external_id: 'agent-1', vertical: 'property', transaction: 'rent',
  title: '2-bedroom apartment, Kilimani', description: 'Second floor, borehole water, lift.',
  price: { amount: 85_000, currency: 'KES', period: 'month' }, deposit: { amount: 170_000, currency: 'KES' },
  location: { county: 'Nairobi', area: 'Kilimani' },
  property: { property_type: 'apartment', bedrooms: 2, bathrooms: 2 },
  media: photos(id), publish: true, ...extra,
})
const car = (id = 'STK-2291', extra: Record<string, unknown> = {}) => ({
  external_id: id, agent_external_id: 'agent-1', vertical: 'vehicle', transaction: 'sale', title: 'Toyota Prado TX 2019',
  price: { amount: 6_450_000, currency: 'KES' }, location: { county: 'Nairobi', area: 'Mombasa Road' },
  vehicle: { make: 'Toyota', model: 'Land Cruiser Prado', year: 2019, mileage_km: 68_000, transmission: 'automatic', fuel_type: 'diesel', vin: 'JTEBH3FJ10K123456' },
  media: Array.from({ length: 4 }, (_, i) => ({ kind: 'car_exterior', angle: i * 90, source_url: `https://img.dealer.co.ke/${id}/${i}.jpg` })),
  publish: true, ...extra,
})

async function setup(mode: 'test' | 'live' = 'test') {
  const w = world()
  const app = await w.app()
  const key = w.issue('pa', mode)
  const post = (body: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/v1/listings', headers: auth(key, headers), payload: body as any })
  const patch = (id: string, body: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'PATCH', url: `/v1/listings/${id}`, headers: auth(key, headers), payload: body as any })
  const get = (id: string) => app.inject({ method: 'GET', url: `/v1/listings/${id}`, headers: auth(key) })
  return { w, app, key, post, patch, get }
}

// ── create, media and publishing ────────────────────────────────────────────

test('create: a rental waits for its photos, then goes live once the worker has fetched them', async () => {
  const { w, post, get } = await setup()
  const res = await post(rental())
  assert.equal(res.statusCode, 201, res.body)
  const l = res.json().listing
  assert.match(l.id, /^lst_/)
  assert.equal(l.version, 1)
  assert.equal(l.publication_status, 'submitted')
  assert.equal(l.moderation.reasons[0].code, 'WAITING_FOR_MEDIA')
  assert.deepEqual(l.media.map((m: any) => m.status), ['pending', 'pending', 'pending'])
  assert.equal(l.price.amount, 85_000)
  assert.equal(res.headers['x-request-id'] !== undefined, true)

  await w.runJobs()
  const after = (await get(l.id)).json().listing
  assert.equal(after.publication_status, 'published', JSON.stringify(after.moderation))
  assert.deepEqual(after.media.map((m: any) => m.status), ['ready', 'ready', 'ready'])
  assert.match(after.urls.share, /^https:\/\/app\.test\/p\/tour-/)
  assert.ok(after.expires_at, 'a published listing gets an expiry')
  assert.ok(w.spaces.get(after.tour_id)!.is_published)
  const types = w.listings._outbox.map(e => e.event_type)
  assert.deepEqual(types, ['listing.created', 'listing.published'])
  assert.equal(w.listings._audit[0].action, 'listing.created')
})

test('create: the tour gets the listing facts; USD and reserved map safely', async () => {
  const { w, post } = await setup()
  const res = await post(rental('HSE-1', { price: { amount: 120_000, currency: 'USD', period: 'month' }, deposit: undefined, availability: 'reserved' }))
  assert.equal(res.statusCode, 201, res.body)
  const space = w.spaces.get(res.json().listing.tour_id)!
  assert.equal(space.facts.price_kes ?? null, null, 'USD prices are not written as KES')
  assert.equal(space.facts.listing_status, 'available')
  assert.equal(space.facts.transaction_type, 'rent')
})

test('create: validation, unknown agent, duplicates and decimal money', async () => {
  const { post } = await setup()
  const bad = await post({ ...rental(), price: { amount: 85000.5, currency: 'KES', period: 'month' } })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().error.code, 'VALIDATION_ERROR')
  assert.ok(bad.json().error.fields.some((f: any) => f.field === 'price.amount'))

  const noAgent = await post({ ...rental(), agent_external_id: undefined })
  assert.equal(noAgent.statusCode, 400)
  assert.equal(noAgent.json().error.fields[0].field, 'agent_external_id')

  const unknownAgent = await post({ ...rental(), agent_external_id: 'nobody' })
  assert.equal(unknownAgent.statusCode, 404)
  assert.equal(unknownAgent.json().error.code, 'AGENT_NOT_FOUND')

  const unknownField = await post({ ...rental(), colour_of_door: 'red' })
  assert.equal(unknownField.statusCode, 400, 'unknown fields are refused')

  assert.equal((await post(rental())).statusCode, 201)
  const dup = await post(rental())
  assert.equal(dup.statusCode, 409)
  assert.equal(dup.json().error.code, 'LISTING_EXISTS')
  assert.equal(dup.json().error.listing.external_id, 'HSE-0042')
})

test('create: incomplete listings that ask to publish are rejected with plain reasons', async () => {
  const { post } = await setup()
  const res = await post(rental('HSE-2', { media: [], property: { property_type: 'apartment' } }))
  assert.equal(res.statusCode, 201)
  const l = res.json().listing
  assert.equal(l.publication_status, 'rejected')
  assert.deepEqual(l.moderation.reasons.map((r: any) => r.field).sort(), ['media', 'property.bedrooms'])
  const draft = (await post(rental('HSE-3', { publish: false }))).json().listing
  assert.equal(draft.publication_status, 'draft')
})

test('idempotency: same key and body replays the first answer; a different body is refused', async () => {
  const { w, post } = await setup()
  const h = { 'idempotency-key': '7f3c0b6e-1111-4c4c-9a9a-000000000001' }
  const first = await post(rental(), h)
  const again = await post(rental(), h)
  assert.equal(again.statusCode, 201)
  assert.equal(again.headers['idempotent-replayed'], 'true')
  assert.deepEqual(again.json(), first.json())
  assert.equal(w.refs.length, 1, 'no second listing')
  const reused = await post(rental('OTHER'), h)
  assert.equal(reused.statusCode, 422)
  assert.equal(reused.json().error.code, 'IDEMPOTENCY_KEY_REUSED')
})

// ── updates ─────────────────────────────────────────────────────────────────

test('patch: versions, If-Match, ownership, stale and unchanged updates', async () => {
  const { w, post, patch, get } = await setup()
  const id = (await post(rental())).json().listing.id
  await w.runJobs()

  const conflict = await patch(id, { availability: 'rented' }, { 'if-match': '"7"' })
  assert.equal(conflict.statusCode, 409)
  assert.equal(conflict.json().error.code, 'VERSION_CONFLICT')

  const v = (await get(id)).json().listing.version
  const ok = await patch(id, { availability: 'rented', partner_updated_at: '2026-12-01T09:00:00Z' }, { 'if-match': `W/"${v}"` })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().listing.availability, 'rented')
  assert.equal(ok.json().listing.version, v + 1)
  assert.equal(w.spaces.get(ok.json().listing.tour_id)!.facts.listing_status, 'rented')

  const owned = await patch(id, { publication_status: 'published' })
  assert.equal(owned.json().error.code, 'FIELD_OWNED_BY_OTHER')
  const fixed = await patch(id, { vertical: 'vehicle' })
  assert.equal(fixed.json().error.code, 'FIELD_IMMUTABLE')

  const stale = await patch(id, { availability: 'available', partner_updated_at: '2026-12-01T08:30:00Z' })
  assert.equal(stale.statusCode, 200)
  assert.equal(stale.json().applied, false)
  assert.equal(stale.json().reason, 'stale')
  assert.equal(stale.json().listing.availability, 'rented')

  const same = await patch(id, { availability: 'rented' })
  assert.equal(same.json().changed, false)
  assert.equal(same.json().listing.version, v + 1, 'an unchanged re-send does not add a version')

  const badIfMatch = await patch(id, { title: 'x' }, { 'if-match': 'banana' })
  assert.equal(badIfMatch.json().error.code, 'INVALID_IF_MATCH')
  const invalid = await patch(id, { price: { amount: 100, currency: 'KES', period: 'once' } })
  assert.equal(invalid.statusCode, 400, 'a sale period on a rental is refused after merging')
})

test('patch: sending media replaces the list; removed photos leave the tour', async () => {
  const { w, post, patch } = await setup()
  const id = (await post(rental())).json().listing.id
  await w.runJobs()
  const res = await patch(id, { media: [...photos('HSE-0042', 2), { kind: 'photo', source_url: 'https://cdn.acme.co.ke/new.jpg' }] })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json().listing.media.map((m: any) => m.source_url.split('/').pop()), ['0.jpg', '1.jpg', 'new.jpg'])
  assert.ok(w.tourCalls.includes('remove-media'))
})

test('live: a partner\'s first listings are reviewed; approval publishes', async () => {
  const { w, post, get } = await setup('live')
  const id = (await post(rental())).json().listing.id
  await w.runJobs()
  const held = (await get(id)).json().listing
  assert.equal(held.publication_status, 'pending_moderation')
  assert.equal(held.moderation.reasons[0].code, 'FIRST_LISTINGS_REVIEW')
  assert.ok(w.listings._outbox.some(e => e.event_type === 'listing.moderation_held'))

  const r = await w.service().approve(id.slice(4), 'staff-1')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const live = (await get(id)).json().listing
  assert.equal(live.publication_status, 'published')
  assert.equal(w.listings._states.get(id.slice(4))!.reviewed_by, 'staff-1')
})

test('live: a big price drop is held for review, the page keeps the old price, and the listing is locked', async () => {
  const { w, post, patch, get } = await setup('live')
  const id = (await post(rental())).json().listing.id
  await w.runJobs()
  await w.service().approve(id.slice(4), 'staff-1')

  const small = await patch(id, { price: { amount: 80_000, currency: 'KES', period: 'month' } })
  assert.equal(small.statusCode, 200, small.body)
  const drop = await patch(id, { price: { amount: 40_000, currency: 'KES', period: 'month' } })
  assert.equal(drop.statusCode, 202, drop.body)
  assert.equal(drop.json().held_for_review, true)
  const l = (await get(id)).json().listing
  assert.equal(l.price.amount, 80_000, 'the live listing keeps the old price')
  assert.equal(l.moderation.pending_change, true)
  assert.equal(w.spaces.get(l.tour_id)!.facts.price_kes, 80_000, 'the tour keeps the old price')
  const locked = await patch(id, { title: 'New title' })
  assert.equal(locked.statusCode, 423)

  await w.service().approve(id.slice(4), 'staff-2')
  const after = (await get(id)).json().listing
  assert.equal(after.price.amount, 40_000)
  assert.equal(after.publication_status, 'published')
  assert.equal(w.spaces.get(after.tour_id)!.facts.price_kes, 40_000)
})

test('live: contact details in the description and a reused VIN go to review', async () => {
  const { w, post, get } = await setup('live')
  w.listings._states.clear()
  const phone = (await post(rental('HSE-9', { description: 'Call 0712 345 678 to view' }))).json().listing
  await w.runJobs()
  const reasons = (await get(phone.id)).json().listing.moderation.reasons.map((r: any) => r.code)
  assert.ok(reasons.includes('CONTACT_DETAILS_IN_TEXT'), reasons.join())

  const b = w.issue('pb', 'live')
  const app = await w.app()
  await app.inject({ method: 'POST', url: '/v1/listings', headers: auth(b), payload: car('B-1') })
  const a = (await post(car('A-1'))).json().listing
  await w.runJobs()
  const carReasons = (await get(a.id)).json().listing.moderation.reasons.map((r: any) => r.code)
  assert.ok(carReasons.includes('POSSIBLE_DUPLICATE'), carReasons.join())
})

test('vehicles: the VIN is stored only as a hash and shown masked', async () => {
  const { w, post } = await setup()
  const l = (await post(car())).json().listing
  assert.equal(l.vehicle.vin, undefined)
  assert.equal(l.vehicle.vin_masked, '•••••••••••••3456')
  const st = w.listings._states.get(l.id.slice(4))!
  assert.match(st.vin_hash!, /^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(st.listing).includes('JTEBH3FJ10K123456'))
  assert.ok(!JSON.stringify(w.listings._audit).includes('JTEBH3FJ10K123456'), 'the audit log never holds the raw VIN')
  assert.ok(w.tourCalls.some(c => c.startsWith('car ')))
})

// ── archive, restore, expiry ────────────────────────────────────────────────

test('archive and restore within 30 days; after that the window has passed', async () => {
  const { w, app, key, post } = await setup()
  const id = (await post(rental())).json().listing.id
  await w.runJobs()
  const del = await app.inject({ method: 'DELETE', url: `/v1/listings/${id}`, headers: auth(key), payload: { reason: 'Let' } })
  assert.equal(del.statusCode, 200, del.body)
  assert.equal(del.json().listing.publication_status, 'archived')
  assert.ok(del.json().listing.restore_until)
  assert.equal(w.spaces.get(del.json().listing.tour_id)!.is_published, false)

  const blocked = await app.inject({ method: 'PATCH', url: `/v1/listings/${id}`, headers: auth(key), payload: { title: 'x' } })
  assert.equal(blocked.json().error.code, 'LISTING_ARCHIVED')

  const back = await app.inject({ method: 'POST', url: `/v1/listings/${id}/restore`, headers: auth(key) })
  assert.equal(back.statusCode, 200, back.body)
  assert.equal(back.json().listing.publication_status, 'published')

  await app.inject({ method: 'DELETE', url: `/v1/listings/${id}`, headers: auth(key) })
  w.advance(31 * 86400_000)
  const late = await app.inject({ method: 'POST', url: `/v1/listings/${id}/restore`, headers: auth(key) })
  assert.equal(late.statusCode, 410)
  assert.equal(late.json().error.code, 'RESTORE_WINDOW_PASSED')
})

test('removing more than 10% of active listings in an hour is held unless confirmed', async () => {
  const { w, app, key, post } = await setup()
  const ids: string[] = []
  for (let i = 0; i < 20; i++) ids.push((await post(rental(`H-${i}`, { publish: false }))).json().listing.id)
  const del = (id: string, payload: object = {}) => app.inject({ method: 'DELETE', url: `/v1/listings/${id}`, headers: auth(key), payload })
  assert.equal((await del(ids[0])).statusCode, 200)
  assert.equal((await del(ids[1])).statusCode, 200)
  const third = await del(ids[2])
  assert.equal(third.statusCode, 409)
  assert.equal(third.json().error.code, 'BULK_DELETE_HELD')
  assert.equal((await del(ids[2], { confirm_bulk_delete: true })).statusCode, 200)
})

test('expiry: a listing with no update for 60 days expires; a re-send brings it back', async () => {
  const { w, post, patch, get } = await setup()
  const id = (await post(rental())).json().listing.id
  await w.runJobs()
  w.advance(59 * 86400_000)
  assert.equal((await patch(id, { availability: 'available' })).json().changed, false, 'a re-send confirms')
  w.advance(59 * 86400_000)
  await w.runJobs(1)
  assert.equal((await get(id)).json().listing.publication_status, 'published', 'confirmed 59 days ago: still live')
  w.advance(2 * 86400_000)
  await w.runJobs(1)
  const l = (await get(id)).json().listing
  assert.equal(l.publication_status, 'expired')
  assert.equal(w.spaces.get(l.tour_id)!.is_published, false)
  assert.ok(w.listings._outbox.some(e => e.event_type === 'listing.expired'))
  const back = await patch(id, { availability: 'available' })
  assert.equal(back.json().listing.publication_status, 'published')
})

// ── tenancy, scopes, keys ───────────────────────────────────────────────────

test('cross-tenant: another partner, or the other mode, gets 404 on every listing endpoint', async () => {
  const { w, app, post } = await setup()
  const created = (await post(rental())).json().listing
  const otherPartner = w.issue('pb', 'test')
  const liveSameP = w.issue('pa', 'live')
  for (const k of [otherPartner, liveSameP]) {
    for (const id of [created.id, `ext:${created.external_id}`]) {
      for (const [method, url, payload] of [
        ['GET', `/v1/listings/${id}`, undefined], ['PATCH', `/v1/listings/${id}`, { title: 'Hijack' }],
        ['DELETE', `/v1/listings/${id}`, {}], ['POST', `/v1/listings/${id}/restore`, undefined],
      ] as const) {
        const r = await app.inject({ method, url, headers: auth(k), payload: payload as any })
        assert.equal(r.statusCode, 404, `${method} ${url} → ${r.statusCode}`)
      }
    }
    const media = await app.inject({ method: 'POST', url: '/v1/media', headers: auth(k), payload: { listing_id: created.id, kind: 'photo', source_url: 'https://x.co.ke/a.jpg' } })
    assert.equal(media.statusCode, 404)
    const list = await app.inject({ method: 'GET', url: '/v1/listings', headers: auth(k) })
    assert.deepEqual(list.json().data, [])
    const leads = await app.inject({ method: 'GET', url: `/v1/analytics?from=2026-11-01&to=2026-11-30&listing_id=${created.id}`, headers: auth(k) })
    assert.equal(leads.statusCode, 404)
  }
  assert.equal(w.spaces.get(created.tour_id)!.title, '2-bedroom apartment, Kilimani')
})

test('scopes, expiry and legacy keys', async () => {
  const w = world()
  const app = await w.app()
  const readOnly = w.issue('pa', 'test', { scopes: ['listings:read'] })
  const r = await app.inject({ method: 'POST', url: '/v1/listings', headers: auth(readOnly), payload: rental() })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().error.code, 'SCOPE_MISSING')
  assert.equal((await app.inject({ method: 'GET', url: '/v1/listings', headers: auth(readOnly) })).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: '/v1/tours', headers: auth(readOnly), payload: {} })).statusCode, 403, '/v1/tours writes need listings:write')

  const legacy = w.issue('pa', 'test', { scopes: null })
  assert.equal((await app.inject({ method: 'GET', url: '/v1/leads', headers: auth(legacy) })).json().error.code, 'SCOPE_MISSING', 'old keys never get leads')
  assert.equal((await app.inject({ method: 'GET', url: '/v1/listings', headers: auth(legacy) })).statusCode, 200)

  const expired = w.issue('pa', 'test', { expiresAt: '2020-01-01T00:00:00Z' })
  assert.equal((await app.inject({ method: 'GET', url: '/v1/listings', headers: auth(expired) })).json().error.code, 'KEY_EXPIRED')

  assert.deepEqual(effectiveScopes(null).includes('leads:read'), false)
  assert.equal(hasScope(['leads:read'], 'leads:read'), true)
  assert.equal(hasScope(['nonsense'], 'listings:read'), false)
})

// ── list, reconcile, bulk ───────────────────────────────────────────────────

test('list: filters and cursor paging', async () => {
  const { w, app, key, post } = await setup()
  for (let i = 0; i < 5; i++) { await post(rental(`P-${i}`, { publish: false, availability: i % 2 ? 'reserved' : 'available' })); w.advance(1000) }
  const page1 = (await app.inject({ method: 'GET', url: '/v1/listings?limit=2', headers: auth(key) })).json()
  assert.deepEqual(page1.data.map((l: any) => l.external_id), ['P-4', 'P-3'])
  const page2 = (await app.inject({ method: 'GET', url: `/v1/listings?limit=2&cursor=${page1.next_cursor}`, headers: auth(key) })).json()
  assert.deepEqual(page2.data.map((l: any) => l.external_id), ['P-2', 'P-1'])
  const reserved = (await app.inject({ method: 'GET', url: '/v1/listings?availability=reserved', headers: auth(key) })).json()
  assert.equal(reserved.data.length, 2)
  const bad = await app.inject({ method: 'GET', url: '/v1/listings?colour=red', headers: auth(key) })
  assert.equal(bad.json().error.code, 'INVALID_FILTER')
  const badCursor = await app.inject({ method: 'GET', url: `/v1/listings?sort=created_at&cursor=${page1.next_cursor}`, headers: auth(key) })
  assert.equal(badCursor.json().error.code, 'INVALID_CURSOR')
})

test('reconcile reports differences without changing anything', async () => {
  const { app, key, post } = await setup()
  await post(rental('A', { publish: false }))
  await post(rental('B', { publish: false }))
  const r = (await app.inject({ method: 'POST', url: '/v1/listings/reconcile', headers: auth(key), payload: { items: [{ external_id: 'A', version: 1 }, { external_id: 'Z' }] } })).json()
  assert.deepEqual(r.not_in_your_list.map((x: any) => x.external_id), ['B'])
  assert.deepEqual(r.unknown_to_viewora, ['Z'])
  assert.deepEqual(r.version_behind, [])
})

test('bulk: 202 at once, the worker creates and updates per row, with per-row errors and an event', async () => {
  const { w, app, key, get } = await setup()
  const items = [rental('B-1', { publish: false }), { ...rental('B-2', { publish: false }), price: { amount: 1.5, currency: 'KES', period: 'month' } }, car('B-3', { publish: false })]
  const res = await app.inject({ method: 'POST', url: '/v1/listings/bulk', headers: auth(key, { 'idempotency-key': 'bulk-1' }), payload: { items } })
  assert.equal(res.statusCode, 202, res.body)
  const { import_id, status_url } = res.json()
  assert.equal(w.refs.length, 0, 'nothing is written on the request path')

  await w.runJobs(1)
  const st = (await app.inject({ method: 'GET', url: status_url, headers: auth(key) })).json()
  assert.equal(st.status, 'completed')
  assert.deepEqual(st.counts, { received: 3, processed: 3, created: 2, updated: 0, unchanged: 0, failed: 1 })
  assert.equal(st.errors[0].index, 1)
  assert.equal(st.errors[0].field, 'price.amount')
  assert.ok(w.listings._outbox.some(e => e.event_type === 'import.completed' && e.payload.import.id === import_id))

  // The same feed again: unchanged; a changed item is a partial update.
  const again = await app.inject({ method: 'POST', url: '/v1/listings/bulk', headers: auth(key), payload: { items: [rental('B-1', { publish: false }), { external_id: 'B-3', availability: 'sold' }] } })
  await w.runJobs(1)
  const st2 = (await app.inject({ method: 'GET', url: again.json().status_url, headers: auth(key) })).json()
  assert.equal(st2.counts.unchanged, 1)
  assert.equal(st2.counts.updated, 1)
  assert.equal((await get('ext:B-3')).json().listing.availability, 'sold')

  const tooMany = await app.inject({ method: 'POST', url: '/v1/listings/bulk', headers: auth(key), payload: { items: Array(501).fill({}) } })
  assert.equal(tooMany.statusCode, 413)
  const other = w.issue('pb', 'test')
  assert.equal((await app.inject({ method: 'GET', url: status_url, headers: auth(other) })).statusCode, 404)
})

test('bulk dry run checks every row and writes nothing', async () => {
  const { w, app, key } = await setup()
  const res = await app.inject({ method: 'POST', url: '/v1/listings/bulk', headers: auth(key), payload: { dry_run: true, items: [rental('D-1'), { external_id: 'D-2' }] } })
  await w.runJobs(1)
  const st = (await app.inject({ method: 'GET', url: res.json().status_url, headers: auth(key) })).json()
  assert.equal(st.counts.created, 1)
  assert.equal(st.counts.failed, 1)
  assert.equal(w.refs.length, 0)
})

// ── media worker ────────────────────────────────────────────────────────────

test('media: wrong file types fail with an event; repeats are skipped; private hosts are refused', async () => {
  const { w, post, get } = await setup()
  const urls = photos('M', 4).map(p => p.source_url)
  w.web.set(urls[1], { status: 200, type: 'text/html' })
  w.web.set(urls[2], { status: 200, body: Buffer.from(`jpeg:${urls[0]}`) })
  w.web.set(urls[3], { status: 0, throws: new SafeFetchError('URL_PRIVATE_NETWORK', 'This URL points to a private network') })
  const id = (await post(rental('M', { media: photos('M', 4) }))).json().listing.id
  await w.runJobs()
  const m = (await get(id)).json().listing.media
  assert.deepEqual(m.map((x: any) => x.status), ['ready', 'failed', 'skipped', 'failed'])
  assert.equal(m[1].error.code, 'UNSUPPORTED_TYPE')
  assert.equal(m[2].error.code, 'DUPLICATE_FILE')
  assert.equal(m[3].error.code, 'URL_PRIVATE_NETWORK')
  assert.equal(w.listings._outbox.filter(e => e.event_type === 'media.failed').length, 2)
})

test('media: a server error is retried later, not failed', async () => {
  const { w, post, get } = await setup()
  const url = photos('R', 1)[0].source_url
  w.web.set(url, { status: 503 })
  const id = (await post(rental('R', { media: photos('R', 1) }))).json().listing.id
  await w.runJobs(1)
  const m = (await get(id)).json().listing.media[0]
  assert.equal(m.status, 'pending')
  assert.equal(m.error.code, 'SOURCE_UNAVAILABLE')
})

test('POST /media adds one file to the listing and is fetched like the rest', async () => {
  const { w, app, key, post, get } = await setup()
  const id = (await post(rental('X', { media: [], publish: false }))).json().listing.id
  const r = await app.inject({ method: 'POST', url: '/v1/media', headers: auth(key), payload: { listing_id: id, kind: 'photo', source_url: 'https://cdn.acme.co.ke/x.jpg' } })
  assert.equal(r.statusCode, 202, r.body)
  await w.runJobs(1)
  const l = (await get(id)).json().listing
  assert.equal(l.media.length, 1)
  assert.equal(l.media[0].status, 'ready')
})

// ── webhooks ────────────────────────────────────────────────────────────────

test('webhooks: register, signed delivery, retries, then dead after 8 attempts', async () => {
  const { w, app, key, post } = await setup()
  const priv = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: auth(key), payload: { url: 'https://192.168.1.5/hook', events: ['*'] } })
  assert.equal(priv.json().error.code, 'URL_PRIVATE_NETWORK')
  const http = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: auth(key), payload: { url: 'http://crm.acme.co.ke/hook', events: ['*'] } })
  assert.equal(http.json().error.code, 'URL_NOT_HTTPS')

  const reg = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: auth(key), payload: { url: 'https://crm.acme.co.ke/hook', events: ['listing.created', 'listing.published'] } })
  assert.equal(reg.statusCode, 201, reg.body)
  const { secret, webhook } = reg.json()
  assert.match(secret, /^whsec_/)
  assert.ok(!JSON.stringify(w.listings._webhooks).includes(secret), 'the secret is stored encrypted')

  await post(rental())
  await w.runJobs()
  const created = w.sent.find(s => s.headers['viewora-event-type'] === 'listing.created')!
  assert.ok(created, 'listing.created delivered')
  assert.ok(verifySignature(secret, created.body, created.headers['viewora-signature'], Math.floor(w.clock() / 1000)))
  const body = JSON.parse(created.body)
  assert.match(body.id, /^evt_/)
  assert.equal(body.data.listing.external_id, 'HSE-0042')
  assert.ok(!w.sent.some(s => s.headers['viewora-event-type'] === 'listing.updated'), 'only subscribed events')

  // A failing endpoint: retried with backoff, then dead.
  w.setHookStatus(500)
  const test = await app.inject({ method: 'POST', url: `/v1/webhooks/${webhook.id}/test`, headers: auth(key) })
  assert.equal(test.statusCode, 202)
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) { await w.runJobs(1); w.advance(25 * 3600_000) }
  const dels = (await app.inject({ method: 'GET', url: `/v1/webhooks/${webhook.id}/deliveries`, headers: auth(key) })).json().deliveries
  const testDel = dels.find((d: any) => d.status === 'dead')
  assert.ok(testDel, JSON.stringify(dels))
  assert.equal(testDel.attempts, MAX_ATTEMPTS)

  const other = w.issue('pb', 'test')
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/webhooks/${webhook.id}`, headers: auth(other) })).statusCode, 404)
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/webhooks/${webhook.id}`, headers: auth(key) })).statusCode, 204)
})

test('webhooks: an endpoint failing for 3 days is switched off and can be re-enabled', async () => {
  const { w, app, key, post } = await setup()
  const { webhook } = (await app.inject({ method: 'POST', url: '/v1/webhooks', headers: auth(key), payload: { url: 'https://crm.acme.co.ke/hook', events: ['*'] } })).json()
  w.setHookStatus(503)
  for (let i = 0; i < 5; i++) { await post(rental(`F-${i}`, { publish: false })); await w.runJobs(1); w.advance(20 * 3600_000) }
  await w.runJobs(1)
  const hooks = (await app.inject({ method: 'GET', url: '/v1/webhooks', headers: auth(key) })).json().webhooks
  assert.equal(hooks[0].status, 'disabled')
  const en = await app.inject({ method: 'POST', url: `/v1/webhooks/${webhook.id}/enable`, headers: auth(key) })
  assert.equal(en.json().webhook.status, 'active')
})

// ── openapi and pure helpers ────────────────────────────────────────────────

test('openapi.json is public and describes every listing endpoint; Postman collection is built from it', async () => {
  const { app } = await setup()
  const r = await app.inject({ method: 'GET', url: '/v1/openapi.json' })
  assert.equal(r.statusCode, 200)
  const spec = r.json()
  assert.equal(spec.openapi, '3.1.0')
  for (const p of ['/listings', '/listings/{id}', '/listings/bulk', '/imports/{id}', '/webhooks', '/leads', '/analytics', '/export/listings']) assert.ok(spec.paths[p], p)
  assert.ok(spec.components.schemas.ListingInput.properties.price)
  const pm = buildPostman(buildOpenApi())
  assert.ok(pm.item.length >= 15)
})

test('helpers: ids, decisions, contact details, private addresses, signatures, secrets, backoff', () => {
  assert.deepEqual(parseListingId('lst_6F1C0000-0000-4000-8000-000000000001'), { refId: '6f1c0000-0000-4000-8000-000000000001' })
  assert.deepEqual(parseListingId('ext:HSE-0042'), { externalId: 'HSE-0042' })
  assert.equal(parseListingId('ext:bad id'), null)
  assert.equal(parseListingId('123'), null)

  assert.ok(contactDetailsInText({ title: 'Flat', description: 'WhatsApp +254 712 345 678' }))
  assert.ok(contactDetailsInText({ title: 'Flat', description: 'see www.example.co.ke/listing' }))
  assert.ok(contactDetailsInText({ title: 'Flat', description: 'email me at jo@example.com' }))
  assert.ok(!contactDetailsInText({ title: '3-bed house, plot 0.25 acres', description: 'KES 12,000,000 negotiable, 2019 build' }))

  const media = { photo: 0, panorama: 0, tour: 0, car_exterior: 0 }
  const l: any = { ...rental(), price: { amount: 1, currency: 'KES', period: 'month' }, location: { county: 'Nairobi', area: 'X', display_precision: 'approx_500m' }, availability: 'withdrawn' }
  assert.equal(decide(l, media, 0, []).status, 'draft', 'withdrawn never publishes')

  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.9', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip)
  for (const ip of ['41.90.64.10', '102.68.12.1', '8.8.8.8', '2c0f:fe38::1']) assert.ok(!isPrivateAddress(ip), ip)
  assert.throws(() => checkUrlShape('http://example.com'), /https/)
  assert.throws(() => checkUrlShape('https://localhost/x'), /private/)
  assert.throws(() => checkUrlShape('https://user:pw@example.com/x'))

  const sig = signPayload('whsec_x', '{"a":1}', 1_800_000_000)
  assert.ok(verifySignature('whsec_x', '{"a":1}', sig, 1_800_000_100))
  assert.ok(!verifySignature('whsec_x', '{"a":2}', sig, 1_800_000_100), 'a changed body fails')
  assert.ok(!verifySignature('whsec_x', '{"a":1}', sig, 1_800_000_000 + 301), 'older than 5 minutes fails')
  assert.equal(decryptSecret(encryptSecret('whsec_abc', KEY), KEY), 'whsec_abc')
  assert.throws(() => decryptSecret(encryptSecret('whsec_abc', KEY), randomBytes(32)))

  assert.equal(nextAttemptDelayMs(1, () => 0.5), 60_000)
  assert.equal(nextAttemptDelayMs(7, () => 0.5), 24 * 3600_000)
  assert.equal(nextAttemptDelayMs(MAX_ATTEMPTS), null)
})

// ── staff tools, leads, analytics, export ───────────────────────────────────

test('admin: the moderation queue, reject with a reason, and a fixed listing goes back to review', async () => {
  const { w, post, patch, get } = await setup('live')
  const id = (await post(rental())).json().listing.id
  await w.runJobs()
  const admin = Fastify()
  await admin.register(partnerListingAdmin, { prefix: '/ops', service: w.service(), listings: w.listings, partners: w.store })
  const q = (await admin.inject({ method: 'GET', url: '/ops/moderation' })).json()
  assert.equal(q.items.length, 1)
  assert.equal(q.items[0].partner_name, 'Acme Homes')
  assert.equal(q.items[0].reasons[0].code, 'FIRST_LISTINGS_REVIEW')

  const bad = await admin.inject({ method: 'POST', url: `/ops/moderation/${id.slice(4)}/reject`, payload: { reasons: [{ code: 'MADE_UP', message: 'x' }] } })
  assert.equal(bad.statusCode, 400, 'only the fixed rejection codes')
  const rej = await admin.inject({ method: 'POST', url: `/ops/moderation/${id.slice(4)}/reject`, payload: { reasons: [{ code: 'IMAGES_NOT_OF_LISTING', message: 'The photos show a different building', field: 'media' }] } })
  assert.equal(rej.statusCode, 200, rej.body)
  const l = (await get(id)).json().listing
  assert.equal(l.publication_status, 'rejected')
  assert.equal(l.moderation.reasons[0].by, 'moderator')
  assert.ok(w.listings._outbox.some(e => e.event_type === 'listing.rejected'))

  const fixed = await patch(id, { title: '2-bedroom apartment, Kilimani (new photos)' })
  const codes = fixed.json().listing.moderation.reasons.map((r: any) => r.code)
  assert.equal(fixed.json().listing.publication_status, 'pending_moderation')
  assert.ok(codes.includes('RESUBMITTED_AFTER_REJECTION'), codes.join())

  const approve = await admin.inject({ method: 'POST', url: `/ops/moderation/${id.slice(4)}/approve` })
  assert.equal(approve.statusCode, 200, approve.body)
  assert.equal((await get(id)).json().listing.publication_status, 'published')
  assert.equal((await admin.inject({ method: 'POST', url: `/ops/moderation/${id.slice(4)}/approve` })).statusCode, 409)
  const dl = (await admin.inject({ method: 'GET', url: '/ops/dead-letters' })).json()
  assert.deepEqual(Object.keys(dl).sort(), ['deliveries', 'imports', 'media'])
})

test('leads need leads:read, are scoped to the partner and every read is logged', async () => {
  const { w, app, post } = await setup()
  const l = (await post(rental('L-1', { publish: false }))).json().listing
  const ref = w.refs.find(r => r.external_id === 'L-1')!
  w.memWorld.leads = [
    { id: 'lead-1', space_id: l.tour_id, ref: { id: ref.id, external_id: 'L-1' }, name: 'Achieng', email: 'a@example.com', phone: '+254712000000', message: 'Is it available?', source: 'form', created_at: '2026-12-01T07:00:00Z', partner_id: 'pa', mode: 'test' },
    { id: 'lead-2', space_id: 'other', ref: { id: 'x', external_id: 'Z' }, name: 'Someone', email: null, phone: null, message: null, source: 'form', created_at: '2026-12-01T07:30:00Z', partner_id: 'pb', mode: 'test' },
  ]
  const noScope = w.issue('pa', 'test')
  assert.equal((await app.inject({ method: 'GET', url: '/v1/leads', headers: auth(noScope) })).statusCode, 403)
  const key = w.issue('pa', 'test', { scopes: ['leads:read', 'listings:read'] })
  const r = (await app.inject({ method: 'GET', url: '/v1/leads', headers: auth(key) })).json()
  assert.equal(r.data.length, 1)
  assert.equal(r.data[0].listing_id, l.id)
  assert.equal(r.data[0].phone, '+254712000000')
  assert.ok(w.listings._audit.some(a => a.action === 'leads.read'))
})

test('analytics: at most 92 days; export lists the agents published tours, including app-made ones', async () => {
  const { w, app, key, post } = await setup()
  const k = w.issue('pa', 'test', { scopes: ['analytics:read', 'listings:read'] })
  assert.equal((await app.inject({ method: 'GET', url: '/v1/analytics?from=2026-01-01&to=2026-12-01', headers: auth(k) })).json().error.code, 'RANGE_TOO_LARGE')
  const l = (await post(rental('AN-1'))).json().listing
  const ref = w.refs.find(r => r.external_id === 'AN-1')!
  w.memWorld.analytics = [{ space_id: l.tour_id, ref: { id: ref.id, external_id: 'AN-1' }, date: '2026-11-30', counts: { total_views: 12, qr_views: 2 }, partner_id: 'pa', mode: 'test' }]
  const a = (await app.inject({ method: 'GET', url: '/v1/analytics?from=2026-11-01&to=2026-11-30', headers: auth(k) })).json()
  assert.deepEqual(a.series[0], { listing_id: l.id, external_id: 'AN-1', date: '2026-11-30', views: 12, total_views: 12, qr_views: 2 })

  const agent = w.agents.find(x => x.partner_id === 'pa' && x.mode === 'test')!
  const base = { title: 'T', slug: 's', property_type: 'residential', is_published: true, cover_image_url: null, price_kes: 1, listing_status: 'available', transaction_type: 'sale', price_period: null, bedrooms: 2, bathrooms: 1, location_text: null, created_at: 'now' }
  w.memWorld.spaces = [
    { ...base, id: l.tour_id, user_id: agent.user_id, updated_at: '2026-12-01T00:00:02Z' },
    { ...base, id: 'app-made', user_id: agent.user_id, updated_at: '2026-12-01T00:00:01Z', slug: 'app' },
    { ...base, id: 'someone-else', user_id: 'stranger', updated_at: '2026-12-01T00:00:03Z' },
  ]
  const e = (await app.inject({ method: 'GET', url: '/v1/export/listings?limit=1', headers: auth(key) })).json()
  assert.equal(e.data[0].origin, 'partner')
  assert.equal(e.data[0].listing_id, l.id)
  const e2 = (await app.inject({ method: 'GET', url: `/v1/export/listings?limit=1&cursor=${e.next_cursor}`, headers: auth(key) })).json()
  assert.equal(e2.data[0].origin, 'viewora')
  assert.equal(e2.data[0].urls.share, 'https://app.viewora.software/p/app')
  assert.equal(e2.next_cursor, null, 'tours of other accounts never appear')
})
