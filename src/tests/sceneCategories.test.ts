import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import scenesRoutes from '../routes/scenes.js'

const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const SCENE_A = '22222222-2222-4222-8222-222222222222'
const SCENE_B = '44444444-4444-4444-8444-444444444444'
const URL = `/spaces/${SPACE_ID}/scenes/category`

function createAuthDecorator() {
  return async (request: any, reply: any) => {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ statusMessage: 'Missing token', code: 'UNAUTHORIZED' })
    }
    request.user = { sub: 'user-1' }
  }
}

// Chainable query-builder stub that records every update and filter call.
function supabaseStub(result: (table: string, op: string) => { data: unknown; error: unknown }) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  return {
    calls,
    from(table: string) {
      let op = 'select'
      const builder: any = {}
      for (const m of ['select', 'eq', 'in', 'or', 'order', 'limit']) {
        builder[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return builder }
      }
      for (const m of ['insert', 'update', 'delete']) {
        builder[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); op = m; return builder }
      }
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
  await app.register(scenesRoutes)
  return app
}

const ownedSpace = (table: string, op: string) => {
  if (table === 'properties') return { data: { id: SPACE_ID }, error: null }
  if (table === 'scenes' && op === 'update') return { data: [{ id: SCENE_A }, { id: SCENE_B }], error: null }
  return { data: null, error: null }
}

test('bulk category requires auth', async () => {
  const app = await buildApp(supabaseStub(ownedSpace))
  const res = await app.inject({ method: 'PATCH', url: URL, payload: { scene_ids: [SCENE_A], group_name: 'Retail' } })
  assert.equal(res.statusCode, 401)
})

test('bulk category rejects an empty or invalid id list', async () => {
  const app = await buildApp(supabaseStub(ownedSpace))
  for (const scene_ids of [[], ['not-a-uuid']]) {
    const res = await app.inject({
      method: 'PATCH', url: URL, headers: { authorization: 'Bearer token' },
      payload: { scene_ids, group_name: 'Retail' },
    })
    assert.equal(res.statusCode, 400)
  }
})

test('bulk category on someone else’s space changes nothing', async () => {
  const stub = supabaseStub(() => ({ data: null, error: null }))
  const app = await buildApp(stub)
  const res = await app.inject({
    method: 'PATCH', url: URL, headers: { authorization: 'Bearer token' },
    payload: { scene_ids: [SCENE_A], group_name: 'Retail' },
  })
  assert.equal(res.statusCode, 404)
  assert.equal(stub.calls.some(c => c.method === 'update'), false)
})

test('bulk category updates only this space’s scenes in one write', async () => {
  const stub = supabaseStub(ownedSpace)
  const app = await buildApp(stub)
  const res = await app.inject({
    method: 'PATCH', url: URL, headers: { authorization: 'Bearer token' },
    payload: { scene_ids: [SCENE_A, SCENE_B, SCENE_A], group_name: '  Food Court ' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { updated: 2, scene_ids: [SCENE_A, SCENE_B], group_name: 'Food Court' })

  const sceneCalls = stub.calls.filter(c => c.table === 'scenes')
  assert.deepEqual(sceneCalls.filter(c => c.method === 'update').map(c => c.args[0]), [{ group_name: 'Food Court' }])
  assert.deepEqual(sceneCalls.find(c => c.method === 'in')?.args, ['id', [SCENE_A, SCENE_B]])
  assert.deepEqual(sceneCalls.find(c => c.method === 'eq')?.args, ['space_id', SPACE_ID])
})

test('bulk category with an empty name clears the category', async () => {
  const stub = supabaseStub(ownedSpace)
  const app = await buildApp(stub)
  const res = await app.inject({
    method: 'PATCH', url: URL, headers: { authorization: 'Bearer token' },
    payload: { scene_ids: [SCENE_A], group_name: '' },
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(stub.calls.find(c => c.method === 'update')?.args[0], { group_name: null })
})
