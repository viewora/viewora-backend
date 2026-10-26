import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import floorPlanRoutes, { mergeScenePlanPins, publicFloorPlans, VenueBody } from '../routes/floorPlans.js'
import scenesRoutes from '../routes/scenes.js'
import { isValidFileType } from '../utils/quotas.js'

const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const SCENE_ID = '22222222-2222-4222-8222-222222222222'
const FLOOR_ID = '33333333-3333-4333-8333-333333333333'

function createAuthDecorator() {
  return async (request: any, reply: any) => {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ statusMessage: 'Missing token', code: 'UNAUTHORIZED' })
    }
    request.user = { sub: 'user-1' }
  }
}

// Chainable query-builder stub: every filter returns the same builder, and
// awaiting it (or .single()/.maybeSingle()) resolves to `result(table)`.
function supabaseStub(result: (table: string, op: string) => { data: unknown; error: unknown; count?: number }) {
  return {
    from(table: string) {
      let op = 'select'
      const builder: any = {}
      for (const m of ['select', 'eq', 'in', 'or', 'order', 'limit']) builder[m] = () => builder
      for (const m of ['insert', 'update', 'delete']) builder[m] = () => { op = m; return builder }
      builder.single = async () => result(table, op)
      builder.maybeSingle = async () => result(table, op)
      builder.then = (resolve: any, reject: any) => Promise.resolve(result(table, op)).then(resolve, reject)
      return builder
    },
    rpc: async () => ({ data: null, error: null }),
  }
}

async function buildApp(supabase: any) {
  const app = Fastify()
  app.decorate('authenticate', createAuthDecorator())
  app.decorate('supabase', supabase)
  app.decorate('redis', null as any)
  await app.register(floorPlanRoutes)
  await app.register(scenesRoutes)
  return app
}

test('creating a floor plan requires auth', async () => {
  const app = await buildApp(supabaseStub(() => ({ data: null, error: null })))
  const res = await app.inject({
    method: 'POST',
    url: `/spaces/${SPACE_ID}/floor-plans`,
    payload: { image_url: 'https://cdn.example.com/plan.png' },
  })
  assert.equal(res.statusCode, 401)
})

test('creating a floor plan rejects a non-http image url', async () => {
  const app = await buildApp(supabaseStub(() => ({ data: null, error: null })))
  const res = await app.inject({
    method: 'POST',
    url: `/spaces/${SPACE_ID}/floor-plans`,
    headers: { authorization: 'Bearer token' },
    payload: { image_url: 'javascript:alert(1)' },
  })
  assert.equal(res.statusCode, 400)
})

test('scene pin coordinates outside 0–1 are rejected', async () => {
  const app = await buildApp(supabaseStub(() => ({ data: null, error: null })))
  const res = await app.inject({
    method: 'PATCH',
    url: `/scenes/${SCENE_ID}`,
    headers: { authorization: 'Bearer token' },
    payload: { floor_plan_id: FLOOR_ID, plan_x: 1.4, plan_y: 0.5 },
  })
  assert.equal(res.statusCode, 400)
})

test('a scene cannot be pinned on another space’s floor plan', async () => {
  let sceneUpdated = false
  const app = await buildApp(supabaseStub((table, op) => {
    if (table === 'scenes' && op === 'select') return { data: { id: SCENE_ID, space_id: SPACE_ID }, error: null }
    if (table === 'floor_plans') return { data: null, error: null } // not in this space
    if (table === 'scenes' && op === 'update') sceneUpdated = true
    return { data: null, error: null }
  }))
  const res = await app.inject({
    method: 'PATCH',
    url: `/scenes/${SCENE_ID}`,
    headers: { authorization: 'Bearer token' },
    payload: { floor_plan_id: FLOOR_ID, plan_x: 0.25, plan_y: 0.75 },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(sceneUpdated, false)
})

test('mergeScenePlanPins copies pins onto public scene rows', async () => {
  const fastify: any = {
    supabase: supabaseStub(() => ({
      data: [{ id: SCENE_ID, floor_plan_id: FLOOR_ID, plan_x: 0.2, plan_y: 0.8, north_offset: 90 }],
      error: null,
    })),
  }
  const scenes: any[] = [{ id: SCENE_ID, name: 'Kitchen' }, { id: 'other', name: 'Hall' }]
  await mergeScenePlanPins(fastify, SPACE_ID, scenes)
  assert.deepEqual(scenes[0], { id: SCENE_ID, name: 'Kitchen', floor_plan_id: FLOOR_ID, plan_x: 0.2, plan_y: 0.8, north_offset: 90 })
  assert.deepEqual(scenes[1], { id: 'other', name: 'Hall' })
})

test('public floor-plan helpers are no-ops before the migration runs', async () => {
  const fastify: any = {
    supabase: supabaseStub(() => ({ data: null, error: { message: 'column scenes.floor_plan_id does not exist' } })),
  }
  const scenes: any[] = [{ id: SCENE_ID, name: 'Kitchen' }]
  await mergeScenePlanPins(fastify, SPACE_ID, scenes)
  assert.deepEqual(scenes, [{ id: SCENE_ID, name: 'Kitchen' }])
  assert.deepEqual(await publicFloorPlans(fastify, SPACE_ID), [])
})

test('floor plan images must be PNG or JPG', () => {
  assert.equal(isValidFileType('image/png', 'floor_plan_image'), true)
  assert.equal(isValidFileType('image/jpeg', 'floor_plan_image'), true)
  assert.equal(isValidFileType('image/webp', 'floor_plan_image'), false)
  assert.equal(isValidFileType('image/svg+xml', 'floor_plan_image'), false)
  // Aerial maps' existing 'floor_plan' type is unchanged.
  assert.equal(isValidFileType('image/webp', 'floor_plan'), true)
})

// ── Venue maps ──────────────────────────────────────────────
const VENUE = {
  places: [{ id: 'gf-shop1', name: 'Shop One', category: 'Fashion', x: 0.4, y: 0.5, entrances: [1] }],
  nodes: [[0.1, 0.1], [0.4, 0.5], [0.6, 0.5]],
  edges: [[0, 1], [1, 2, 1]],
  links: [{ node: 2, group: 'lift-a', kind: 'lift' }],
}

test('venue schema accepts a floor directory with walkways', () => {
  assert.equal(VenueBody.safeParse(VENUE).success, true)
})

test('venue schema rejects walkways pointing at missing points', () => {
  assert.equal(VenueBody.safeParse({ ...VENUE, edges: [[0, 7]] }).success, false)
  assert.equal(VenueBody.safeParse({ ...VENUE, links: [{ node: 9, group: 'x' }] }).success, false)
  assert.equal(VenueBody.safeParse({ ...VENUE, places: [{ ...VENUE.places[0], entrances: [5] }] }).success, false)
})

test('venue schema rejects unsafe shop links', () => {
  assert.equal(VenueBody.safeParse({ ...VENUE, places: [{ ...VENUE.places[0], url: 'javascript:alert(1)' }] }).success, false)
})

test('saving a venue map stores it on the owned floor', async () => {
  let saved: unknown = undefined
  const app = await buildApp(supabaseStub((table, op) => {
    if (table === 'subscriptions') return { data: { status: 'active', plans: {} }, error: null }
    if (table === 'floor_plans' && op === 'select') return { data: { id: FLOOR_ID, space_id: SPACE_ID }, error: null }
    if (table === 'floor_plans' && op === 'update') saved = true
    return { data: null, error: null }
  }))
  const res = await app.inject({
    method: 'PUT',
    url: `/floor-plans/${FLOOR_ID}/venue`,
    headers: { authorization: 'Bearer token' },
    payload: { venue: VENUE },
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(saved, true)
})

test('publicFloorPlans serves floors without venue when the column is missing', async () => {
  const fastify: any = {
    supabase: supabaseStub(() => ({ data: null, error: null })),
  }
  let call = 0
  fastify.supabase = {
    from() {
      call++
      const first = call === 1
      const b: any = {}
      for (const m of ['select', 'eq', 'in', 'order']) b[m] = () => b
      b.then = (res: any) => Promise.resolve(first
        ? { data: [{ id: FLOOR_ID, name: 'Ground Floor' }], error: null }
        : { data: null, error: { message: 'column floor_plans.venue does not exist' } }).then(res)
      return b
    },
  }
  const rows = await publicFloorPlans(fastify, SPACE_ID)
  assert.deepEqual(rows, [{ id: FLOOR_ID, name: 'Ground Floor' }])
})
