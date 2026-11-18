import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import partnerApi, { type CallAs } from '../routes/partnerApi.js'
import { generatePartnerKey, hashPartnerKey, parsePartnerKey } from '../utils/partnerKeys.js'
import type { AgentRow, KeyRecord, Partner, PartnerStore, SpaceSummary, TourRefRow } from '../partners/store.js'

// ── keys ──────────────────────────────────────────────────────────────────────

test('generated keys parse, hash consistently, and are unique', () => {
  const a = generatePartnerKey('live')
  const b = generatePartnerKey('live')
  assert.match(a.key, /^vo_live_[0-9A-Za-z]{32}$/)
  assert.notEqual(a.key, b.key)
  assert.equal(a.hash, hashPartnerKey(a.key))
  assert.equal(a.prefix, a.key.slice(0, 12))
  assert.deepEqual(parsePartnerKey(`Bearer ${a.key}`), { key: a.key, mode: 'live' })
  assert.equal(parsePartnerKey(`Bearer ${a.key}x`), null)
  assert.equal(parsePartnerKey('Bearer sk_live_abc'), null)
  assert.equal(parsePartnerKey(undefined), null)
})

// ── in-memory store + fake inner routes ──────────────────────────────────────

const MEDIA = 'https://media.test'

function world() {
  const partners: Record<string, Partner> = {
    p1: { id: 'p1', slug: 'carsite', name: 'Car Site', status: 'active', allowed_embed_origins: [], daily_upload_cap: 3, agent_plan_id: 'pro', paid_until: '2099-01-01T00:00:00Z', max_agents: 2 },
    p2: { id: 'p2', slug: 'homesite', name: 'Home Site', status: 'active', allowed_embed_origins: [], daily_upload_cap: 100, agent_plan_id: null, paid_until: null, max_agents: null },
  }
  const keys = new Map<string, KeyRecord>()
  const issue = (pid: string, mode: 'test' | 'live' = 'live', revoked = false) => {
    const k = generatePartnerKey(mode)
    keys.set(k.hash, { keyId: `k-${keys.size}`, mode, revoked, partner: partners[pid] })
    return k.key
  }
  const agents: AgentRow[] = []
  const planSyncs: { plan: string | null; userId: string }[] = []
  const tours: TourRefRow[] = []
  const spaces = new Map<string, SpaceSummary>()
  const scenes = new Set<string>()
  const views = new Set<string>()
  const users = new Set<string>(['taken@mail.com'])
  const userIds: string[] = []
  let n = 0
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

  const store: PartnerStore = {
    findKeyByHash: async h => keys.get(h) ?? null,
    touchKey: async () => {},
    getAgent: async (pid, mode, ext) => agents.find(a => a.partner_id === pid && a.mode === mode && a.external_id === ext) ?? null,
    getAgentsByIds: async ids => agents.filter(a => ids.includes(a.id)),
    listAgents: async (pid, mode) => agents.filter(a => a.partner_id === pid && a.mode === mode),
    countAgents: async (pid, mode) => agents.filter(a => a.partner_id === pid && a.mode === mode).length,
    syncAgentPlan: async (p, userId) => { planSyncs.push({ plan: p.agent_plan_id, userId }) },
    insertAgent: async row => {
      if (agents.some(a => a.partner_id === row.partner_id && a.mode === row.mode && a.external_id === row.external_id)) return 'duplicate'
      const r = { ...row, id: id(), created_at: 'now' }
      agents.push(r)
      return r
    },
    createAuthUser: async ({ email }) => {
      if (users.has(email)) return { error: 'email_in_use' }
      users.add(email)
      const uid = id()
      userIds.push(uid)
      return { userId: uid }
    },
    deleteAuthUser: async () => {},
    getTourRef: async (pid, mode, by) => tours.find(t => t.partner_id === pid && t.mode === mode &&
      (by.spaceId ? t.space_id === by.spaceId : t.external_id === by.externalId)) ?? null,
    listTourRefs: async (pid, mode, o) => tours.filter(t => t.partner_id === pid && t.mode === mode && (!o.agentId || t.agent_id === o.agentId)),
    insertTourRef: async row => {
      if (tours.some(t => t.partner_id === row.partner_id && t.mode === row.mode && t.external_id === row.external_id)) return 'duplicate'
      const r = { ...row, id: id(), created_at: 'now' }
      tours.push(r)
      return r
    },
    deleteTourRef: async rid => { const i = tours.findIndex(t => t.id === rid); if (i >= 0) tours.splice(i, 1) },
    getSpaces: async ids => ids.flatMap(i => spaces.get(i) ?? []),
    sceneExists: async (_s, url) => scenes.has(url),
    vehicleViewExists: async (_s, url) => views.has(url),
  }

  // Stands in for the existing dashboard routes, run as the agent.
  const calls: { userId: string; method: string; url: string; payload: any }[] = []
  let publishStatus = 200
  const callAs: CallAs = async (userId, method, url, payload: any) => {
    calls.push({ userId, method, url, payload })
    if (method === 'POST' && url === '/spaces') {
      const sid = id()
      spaces.set(sid, { id: sid, title: payload.title, slug: null, property_type: payload.space_type, is_published: false,
        cover_image_url: null, has_360: false, has_gallery: false, created_at: 'now', updated_at: 'now' })
      ;(spaces.get(sid) as any).owner = userId
      return { status: 201, body: { id: sid } }
    }
    const m = /^\/spaces\/([^/]+)(\/.*)?$/.exec(url)
    if (m && (spaces.get(m[1]) as any)?.owner !== userId) return { status: 404, body: { statusMessage: 'Space not found' } }
    if (url.endsWith('/publish')) {
      if (publishStatus !== 200) return { status: publishStatus, body: { statusMessage: 'Add a 360° scene first.' } }
      const s = spaces.get(m![1])!
      s.is_published = payload.publish; s.slug = payload.publish ? 'nice-house' : s.slug
      return { status: 200, body: {} }
    }
    if (method === 'DELETE' && m) { spaces.delete(m[1]); return { status: 200, body: {} } }
    if (url === '/uploads/create-signed-url') {
      return { status: 200, body: { objectKey: `users/${userId}/spaces/${payload.spaceId}/x/1.jpg`, signedUrl: 'https://r2/signed' } }
    }
    if (url === '/uploads/complete') return { status: 200, body: { id: 'media-1' } }
    if (url.endsWith('/scenes')) { scenes.add(payload.raw_image_url); return { status: 201, body: {} } }
    if (url.endsWith('/vehicle-views')) { views.add(payload.image_url); return { status: 201, body: {} } }
    return { status: 500, body: {} }
  }

  let counter = 0
  const redis: any = {
    get: async () => null, setEx: async () => {}, del: async () => {},
    incr: async () => ++counter, expire: async () => {},
  }

  async function app() {
    const a = Fastify()
    a.decorate('redis', redis)
    await a.register(partnerApi, { prefix: '/v1', store, callAs, appUrl: 'https://app.test', mediaBaseUrl: MEDIA })
    return a
  }
  return {
    app, issue, calls, agents, tours, spaces, userIds, planSyncs,
    setPublishStatus: (s: number) => { publishStatus = s },
  }
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` })

async function setup(w = world(), mode: 'live' | 'test' = 'live') {
  const app = await w.app()
  const key = w.issue('p1', mode)
  const agentRes = await app.inject({ method: 'POST', url: '/v1/agents', headers: auth(key),
    payload: { external_id: 'dealer-7', name: 'Wanjiku Motors', email: 'wanjiku@mail.com' } })
  assert.equal(agentRes.statusCode, 201, agentRes.body)
  const tourRes = await app.inject({ method: 'POST', url: '/v1/tours', headers: auth(key),
    payload: { agent_external_id: 'dealer-7', external_id: 'CAR-123', title: 'Toyota Prado 2019', type: 'automotive', details: { vehicle_year: 2019, bogus: 1 } } })
  assert.equal(tourRes.statusCode, 201, tourRes.body)
  return { w, app, key, tour: tourRes.json().tour }
}

// ── auth ─────────────────────────────────────────────────────────────────────

test('requests without a valid, unrevoked key are refused', async () => {
  const w = world()
  const app = await w.app()
  assert.equal((await app.inject({ method: 'GET', url: '/v1/tours' })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/v1/tours', headers: auth(generatePartnerKey('live').key) })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/v1/tours', headers: auth(w.issue('p1', 'live', true)) })).statusCode, 401)
  assert.equal((await app.inject({ method: 'GET', url: '/v1/tours', headers: auth(w.issue('p1')) })).statusCode, 200)
  await app.close()
})

// ── agents ───────────────────────────────────────────────────────────────────

test('creating an agent makes a Viewora account once; repeating it is safe', async () => {
  const { w, app, key } = await setup()
  assert.equal(w.userIds.length, 1)
  const again = await app.inject({ method: 'POST', url: '/v1/agents', headers: auth(key),
    payload: { external_id: 'dealer-7', name: 'Wanjiku Motors', email: 'wanjiku@mail.com' } })
  assert.equal(again.statusCode, 200)
  assert.equal(again.json().created, false)
  assert.equal(w.userIds.length, 1)
  await app.close()
})

test("a new agent is put on the partner's paid plan", async () => {
  const { w, app } = await setup()
  assert.deepEqual(w.planSyncs, [{ plan: 'pro', userId: w.agents[0].user_id }])
  await app.close()
})

test('live agents stop at the seats the partner paid for; test agents do not use seats', async () => {
  const { w, app, key } = await setup() // p1 has 2 seats, 1 used
  const add = (k: string, ext: string) => app.inject({ method: 'POST', url: '/v1/agents', headers: auth(k),
    payload: { external_id: ext, name: ext, email: `${ext}@mail.com` } })
  assert.equal((await add(key, 'second')).statusCode, 201)
  const third = await add(key, 'third')
  assert.equal(third.statusCode, 403)
  assert.equal(third.json().error.code, 'AGENT_LIMIT_REACHED')
  assert.equal(w.userIds.length, 2) // no account made for the refused one
  assert.equal((await add(w.issue('p1', 'test'), 'third')).statusCode, 201)
  await app.close()
})

test('an email that already has a Viewora account is never linked silently', async () => {
  const w = world()
  const app = await w.app()
  const res = await app.inject({ method: 'POST', url: '/v1/agents', headers: auth(w.issue('p1')),
    payload: { external_id: 'a1', name: 'A', email: 'taken@mail.com' } })
  assert.equal(res.statusCode, 409)
  assert.equal(res.json().error.code, 'EMAIL_IN_USE')
  assert.equal(w.agents.length, 0)
  await app.close()
})

test('live agents need an email; test agents never use a real one', async () => {
  const w = world()
  const app = await w.app()
  const live = await app.inject({ method: 'POST', url: '/v1/agents', headers: auth(w.issue('p1')), payload: { external_id: 'a1', name: 'A' } })
  assert.equal(live.statusCode, 400)
  const t = await app.inject({ method: 'POST', url: '/v1/agents', headers: auth(w.issue('p1', 'test')),
    payload: { external_id: 'a1', name: 'A', email: 'taken@mail.com' } })
  assert.equal(t.statusCode, 201, t.body)
  await app.close()
})

// ── tours ────────────────────────────────────────────────────────────────────

test('a tour is created as the agent, with only known listing facts passed on', async () => {
  const { w, tour, app } = await setup()
  const create = w.calls.find(c => c.url === '/spaces')!
  assert.equal(create.userId, w.agents[0].user_id)
  assert.equal(create.payload.vehicle_year, 2019)
  assert.equal('bogus' in create.payload, false)
  assert.equal(tour.external_id, 'CAR-123')
  assert.equal(tour.agent_external_id, 'dealer-7')
  assert.equal(tour.status, 'draft')
  assert.equal(tour.embed_url, null)
  await app.close()
})

test('the same external_id cannot make two tours', async () => {
  const { w, app, key } = await setup()
  const dup = await app.inject({ method: 'POST', url: '/v1/tours', headers: auth(key),
    payload: { agent_external_id: 'dealer-7', external_id: 'CAR-123', title: 'Again', type: 'automotive' } })
  assert.equal(dup.statusCode, 409)
  assert.equal(dup.json().error.code, 'TOUR_EXISTS')
  assert.equal(dup.json().error.tour.external_id, 'CAR-123')
  assert.equal(w.spaces.size, 1)
  await app.close()
})

test('a tour for an unknown agent is refused before anything is created', async () => {
  const w = world()
  const app = await w.app()
  const res = await app.inject({ method: 'POST', url: '/v1/tours', headers: auth(w.issue('p1')),
    payload: { agent_external_id: 'nobody', external_id: 'X', title: 'X', type: 'residential' } })
  assert.equal(res.statusCode, 404)
  assert.equal(w.spaces.size, 0)
  await app.close()
})

test('partners cannot see or change each other\'s tours, and test keys cannot see live tours', async () => {
  const { w, app, tour } = await setup()
  const other = w.issue('p2')
  for (const req of [
    { method: 'GET' as const, url: `/v1/tours/${tour.id}` },
    { method: 'POST' as const, url: `/v1/tours/${tour.id}/publish` },
    { method: 'DELETE' as const, url: `/v1/tours/${tour.id}` },
    { method: 'POST' as const, url: `/v1/tours/${tour.id}/uploads`, payload: { kind: 'photo', file_name: 'a.jpg', content_type: 'image/jpeg', file_size: 10 } },
  ]) {
    const res = await app.inject({ ...req, headers: auth(other) })
    assert.equal(res.statusCode, 404, `${req.method} ${req.url}`)
  }
  const list = await app.inject({ method: 'GET', url: '/v1/tours', headers: auth(other) })
  assert.deepEqual(list.json().tours, [])
  const testKey = w.issue('p1', 'test')
  assert.equal((await app.inject({ method: 'GET', url: `/v1/tours/${tour.id}`, headers: auth(testKey) })).statusCode, 404)
  assert.equal(w.spaces.size, 1)
  await app.close()
})

test('lookup by the partner\'s own listing id', async () => {
  const { app, key, tour } = await setup()
  const res = await app.inject({ method: 'GET', url: '/v1/tours?external_id=CAR-123', headers: auth(key) })
  assert.equal(res.json().tours[0].id, tour.id)
  const none = await app.inject({ method: 'GET', url: '/v1/tours?external_id=NOPE', headers: auth(key) })
  assert.deepEqual(none.json().tours, [])
  await app.close()
})

// ── create → upload → complete → publish ────────────────────────────────────

test('full flow: upload a panorama and a car photo, then publish and get an embed link', async () => {
  const { w, app, key, tour } = await setup()
  const agentId = w.agents[0].user_id

  const pano = await app.inject({ method: 'POST', url: `/v1/tours/${tour.id}/uploads`, headers: auth(key),
    payload: { kind: 'panorama', file_name: 'lounge.jpg', content_type: 'image/jpeg', file_size: 5_000_000 } })
  assert.equal(pano.statusCode, 201, pano.body)
  const { upload_key, upload_url, method } = pano.json()
  assert.equal(upload_url, 'https://r2/signed')
  assert.equal(method, 'PUT')
  assert.equal(w.calls.at(-1)!.payload.mediaType, 'panorama')

  const done = await app.inject({ method: 'POST', url: `/v1/tours/${tour.id}/uploads/complete`, headers: auth(key),
    payload: { kind: 'panorama', upload_key, name: 'Lounge' } })
  assert.equal(done.statusCode, 200, done.body)
  const complete = w.calls.find(c => c.url === '/uploads/complete')!
  assert.equal(complete.userId, agentId)
  assert.equal(complete.payload.publicUrl, `${MEDIA}/${upload_key}`) // built by us, never taken from the partner
  const scene = w.calls.find(c => c.url.endsWith('/scenes'))!
  assert.equal(scene.payload.raw_image_url, `${MEDIA}/${upload_key}`)
  assert.equal(scene.payload.name, 'Lounge')

  // A retried "complete" must not create a second scene.
  await app.inject({ method: 'POST', url: `/v1/tours/${tour.id}/uploads/complete`, headers: auth(key), payload: { kind: 'panorama', upload_key } })
  assert.equal(w.calls.filter(c => c.url.endsWith('/scenes')).length, 1)

  // Car photo needs an angle.
  const car = await app.inject({ method: 'POST', url: `/v1/tours/${tour.id}/uploads`, headers: auth(key),
    payload: { kind: 'car_exterior', file_name: 'front.jpg', content_type: 'image/jpeg', file_size: 1000 } })
  const noAngle = await app.inject({ method: 'POST', url: `/v1/tours/${tour.id}/uploads/complete`, headers: auth(key),
    payload: { kind: 'car_exterior', upload_key: car.json().upload_key } })
  assert.equal(noAngle.statusCode, 400)
  const withAngle = await app.inject({ method: 'POST', url: `/v1/tours/${tour.id}/uploads/complete`, headers: auth(key),
    payload: { kind: 'car_exterior', upload_key: car.json().upload_key, angle: 0 } })
  assert.equal(withAngle.statusCode, 200, withAngle.body)
  assert.equal(w.calls.find(c => c.url.endsWith('/vehicle-views'))!.payload.media_id, 'media-1')

  const pub = await app.inject({ method: 'POST', url: `/v1/tours/${tour.id}/publish`, headers: auth(key) })
  assert.equal(pub.statusCode, 200, pub.body)
  assert.equal(pub.json().tour.status, 'published')
  assert.equal(pub.json().tour.embed_url, 'https://app.test/embed/nice-house')
  assert.equal(pub.json().tour.share_url, 'https://app.test/p/nice-house')
  await app.close()
})

test('an upload key from another tour is refused', async () => {
  const { app, key, tour } = await setup()
  const res = await app.inject({ method: 'POST', url: `/v1/tours/${tour.id}/uploads/complete`, headers: auth(key),
    payload: { kind: 'photo', upload_key: 'users/someone-else/spaces/other/gallery/1.jpg' } })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error.code, 'INVALID_UPLOAD_KEY')
  await app.close()
})

test('daily upload cap is enforced per partner', async () => {
  const { app, key, tour } = await setup() // p1 cap is 3
  const start = () => app.inject({ method: 'POST', url: `/v1/tours/${tour.id}/uploads`, headers: auth(key),
    payload: { kind: 'photo', file_name: 'a.jpg', content_type: 'image/jpeg', file_size: 10 } })
  for (let i = 0; i < 3; i++) assert.equal((await start()).statusCode, 201)
  const over = await start()
  assert.equal(over.statusCode, 429)
  assert.equal(over.json().error.code, 'DAILY_UPLOAD_CAP')
  await app.close()
})

test('errors from the dashboard rules are passed on in the partner error shape', async () => {
  const { w, app, key, tour } = await setup()
  w.setPublishStatus(400)
  const res = await app.inject({ method: 'POST', url: `/v1/tours/${tour.id}/publish`, headers: auth(key) })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().error.message, 'Add a 360° scene first.')
  await app.close()
})

test('deleting a tour removes it and its listing id', async () => {
  const { w, app, key, tour } = await setup()
  const res = await app.inject({ method: 'DELETE', url: `/v1/tours/${tour.id}`, headers: auth(key) })
  assert.equal(res.statusCode, 204)
  assert.equal(w.spaces.size, 0)
  assert.equal(w.tours.length, 0)
  await app.close()
})

// ── the real in-process call ────────────────────────────────────────────────

test('default callAs runs inner routes as the agent, with a per-agent rate-limit address', async () => {
  process.env.INTERNAL_API_KEY = 'internal-test-key'
  const w = world()
  const app = Fastify()
  let seen: any = null
  app.post('/spaces', async (req, reply) => {
    seen = { key: req.headers['x-internal-api-key'], user: req.headers['x-internal-user-id'], ip: req.ip }
    return reply.code(201).send({ id: '99999999-9999-4999-8999-999999999999' })
  })
  const store = {
    findKeyByHash: async () => ({ keyId: 'k', mode: 'live', revoked: false, partner: { id: 'p1', slug: 's', name: 'n', status: 'active', allowed_embed_origins: [], daily_upload_cap: 5, agent_plan_id: null, paid_until: null, max_agents: null } }),
    touchKey: async () => {},
    getAgent: async () => ({ id: 'ag', partner_id: 'p1', mode: 'live', external_id: 'a', user_id: 'user-abc', name: null, created_at: '' }),
    getAgentsByIds: async () => [],
    getTourRef: async () => null,
    insertTourRef: async (r: any) => ({ ...r, id: 'ref', created_at: '' }),
    getSpaces: async () => [],
  } as unknown as PartnerStore
  await app.register(partnerApi, { prefix: '/v1', store })
  const res = await app.inject({ method: 'POST', url: '/v1/tours', headers: auth(generatePartnerKey('live').key),
    payload: { agent_external_id: 'a', external_id: 'X', title: 'T', type: 'residential' } })
  assert.equal(res.statusCode, 201, res.body)
  assert.deepEqual(seen, { key: 'internal-test-key', user: 'user-abc', ip: 'partner-agent:user-abc' })
  void w
  await app.close()
})
