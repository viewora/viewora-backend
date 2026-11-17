import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import journeyRoutes, { JourneyStep, publicJourneys } from '../routes/journeys.js'

const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const SCENE_ID = '22222222-2222-4222-8222-222222222222'
const JOURNEY_ID = '44444444-4444-4444-8444-444444444444'

function createAuthDecorator() {
  return async (request: any, reply: any) => {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ statusMessage: 'Missing token', code: 'UNAUTHORIZED' })
    }
    request.user = { sub: 'user-1' }
  }
}

// Chainable query-builder stub (as in floorPlans.test.ts); records writes.
function supabaseStub(result: (table: string, op: string) => { data: unknown; error: unknown; count?: number }, writes: any[] = []) {
  return {
    from(table: string) {
      let op = 'select'
      const builder: any = {}
      for (const m of ['select', 'eq', 'in', 'or', 'order', 'limit']) builder[m] = () => builder
      for (const m of ['insert', 'update', 'delete']) builder[m] = (row?: any) => { op = m; writes.push({ table, op, row }); return builder }
      builder.single = async () => result(table, op)
      builder.maybeSingle = async () => result(table, op)
      builder.then = (resolve: any, reject: any) => Promise.resolve(result(table, op)).then(resolve, reject)
      return builder
    },
  }
}

async function buildApp(supabase: any) {
  const app = Fastify()
  app.decorate('authenticate', createAuthDecorator())
  app.decorate('supabase', supabase)
  app.decorate('redis', null as any)
  await app.register(journeyRoutes)
  return app
}

const auth = { authorization: 'Bearer t' }
const step = { id: 's1', title: 'Reception', scene_id: SCENE_ID, view: { yaw: 1.2, pitch: -0.1 }, sentences: [{ id: 'a', text: 'Register at the front desk.' }] }

test('listing journeys requires auth', async () => {
  const app = await buildApp(supabaseStub(() => ({ data: null, error: null })))
  const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE_ID}/journeys` })
  assert.equal(res.statusCode, 401)
})

test("someone else's tour: 404", async () => {
  const app = await buildApp(supabaseStub(() => ({ data: null, error: null })))
  const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE_ID}/journeys`, headers: auth })
  assert.equal(res.statusCode, 404)
})

test('before the migration the list is empty and says so', async () => {
  const app = await buildApp(supabaseStub((table) => table === 'properties'
    ? { data: { id: SPACE_ID }, error: null }
    : { data: null, error: { code: '42P01', message: 'relation "journeys" does not exist' } }))
  const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE_ID}/journeys`, headers: auth })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { journeys: [], enabled: false })
})

test('creates a journey on an owned tour', async () => {
  const writes: any[] = []
  const app = await buildApp(supabaseStub((table, op) => {
    if (table === 'subscriptions') return { data: null, error: { message: 'none' } } // free plan
    if (table === 'plans') return { data: { slug: 'free', max_active_properties: 3 }, error: null }
    if (table === 'properties') return { data: { id: SPACE_ID }, error: null }
    if (table === 'journeys' && op === 'insert') return { data: { id: JOURNEY_ID, title: 'Outpatient visit', steps: [step] }, error: null }
    if (table === 'journeys') return { data: null, error: null, count: 2 }
    return { data: null, error: null }
  }, writes))
  const res = await app.inject({ method: 'POST', url: `/spaces/${SPACE_ID}/journeys`, headers: auth, payload: { title: 'Outpatient visit', steps: [step] } })
  assert.equal(res.statusCode, 201)
  const insert = writes.find(w => w.table === 'journeys' && w.op === 'insert')
  assert.equal(insert.row.order_index, 2) // after the two it already has
  assert.equal(insert.row.steps[0].title, 'Reception')
})

test('step validation: bad scene id, overlong text and odd ids are refused', () => {
  assert.equal(JourneyStep.safeParse(step).success, true)
  assert.equal(JourneyStep.safeParse({ ...step, scene_id: 'not-a-uuid' }).success, false)
  assert.equal(JourneyStep.safeParse({ ...step, sentences: [{ id: 'a', text: 'x'.repeat(401) }] }).success, false)
  assert.equal(JourneyStep.safeParse({ ...step, id: 'a b<script>' }).success, false)
  assert.equal(JourneyStep.safeParse({ ...step, scene_id: null, view: null }).success, true)
})

test('a step keeps its zoom; out-of-range zoom is refused', () => {
  const zoomed = JourneyStep.safeParse({ ...step, view: { yaw: 1.2, pitch: -0.1, zoom: 62.5 } })
  assert.equal(zoomed.success, true)
  assert.equal((zoomed as any).data.view.zoom, 62.5)
  assert.equal(JourneyStep.safeParse({ ...step, view: { yaw: 0, pitch: 0, zoom: 140 } }).success, false)
})

test('each line can keep its own facing', () => {
  const r = JourneyStep.safeParse({ ...step, sentences: [{ id: 'a', text: 'Hi' }, { id: 'b', text: 'Pharmacy on the left.', view: { yaw: -1.5, pitch: 0, zoom: 40 } }] })
  assert.equal(r.success, true)
  assert.deepEqual((r as any).data.sentences[1].view, { yaw: -1.5, pitch: 0, zoom: 40 })
  assert.equal(JourneyStep.safeParse({ ...step, sentences: [{ id: 'a', text: 'x', view: { yaw: 99, pitch: 0 } }] }).success, false)
})

test('updating with a malformed body is refused before any lookup', async () => {
  const app = await buildApp(supabaseStub(() => { throw new Error('should not query') }))
  const res = await app.inject({ method: 'PUT', url: `/journeys/${JOURNEY_ID}`, headers: auth, payload: { steps: 'nope' } })
  assert.equal(res.statusCode, 400)
})

test('publicJourneys: published only, steps always an array, none before the migration', async () => {
  const ok = await publicJourneys({ supabase: supabaseStub(() => ({ data: [{ id: JOURNEY_ID, title: 'Outpatient visit', steps: null, order_index: 0 }], error: null })) } as any, SPACE_ID)
  assert.deepEqual(ok, [{ id: JOURNEY_ID, title: 'Outpatient visit', steps: [] }])
  const missing = await publicJourneys({ supabase: supabaseStub(() => ({ data: null, error: { code: '42P01' } })) } as any, SPACE_ID)
  assert.deepEqual(missing, [])
})
