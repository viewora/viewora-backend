import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import floorPlanRoutes, { mergeScenePlanPins, publicFloorPlans } from '../routes/floorPlans.js'
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
