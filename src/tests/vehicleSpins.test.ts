import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import vehicleViewRoutes, { publicVehicleSpins, MAX_VEHICLE_SPINS } from '../routes/vehicleViews.js'

const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const SPIN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SPIN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_SPIN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

type Ctx = { table: string; op: string; columns: string; filters: Record<string, unknown> }

// Chainable query-builder stub that remembers the selected columns and eq() filters,
// so a test can answer "no such column" the way PostgREST does before a migration.
function supabaseStub(result: (ctx: Ctx) => { data: unknown; error: unknown; count?: number }) {
  return {
    from(table: string) {
      const ctx: Ctx = { table, op: 'select', columns: '', filters: {} }
      const builder: any = {}
      builder.select = (cols?: string) => { if (ctx.op === 'select') ctx.columns = cols ?? ''; return builder }
      builder.eq = (k: string, v: unknown) => { ctx.filters[k] = v; return builder }
      for (const m of ['in', 'or', 'order', 'limit']) builder[m] = () => builder
      for (const m of ['insert', 'update', 'delete']) builder[m] = () => { ctx.op = m; return builder }
      builder.single = async () => result(ctx)
      builder.maybeSingle = async () => result(ctx)
      builder.then = (resolve: any, reject: any) => Promise.resolve(result(ctx)).then(resolve, reject)
      return builder
    },
    rpc: async () => ({ data: null, error: null }),
  }
}

const view = (id: string, angle: number, spin_id: string | null) => ({
  id, image_url: `https://cdn.example.com/${id}.jpg`, label: null, angle, width: 1920, height: 1080,
  order_index: angle, created_at: '2026-11-09T00:00:00Z', spin_id,
})

test('public spins: photos grouped by spin, empty spins dropped, photos without a spin go to the first', async () => {
  const sb = supabaseStub(({ table }) => {
    if (table === 'vehicle_views') return { data: [view('v1', 0, SPIN_A), view('v2', 10, SPIN_B), view('v3', 20, null)], error: null }
    if (table === 'vehicle_spins') {
      return { data: [
        { id: SPIN_A, title: 'Roof up', start_angle: 0, order_index: 0 },
        { id: SPIN_B, title: 'Roof down', start_angle: 90, order_index: 1 },
        { id: OTHER_SPIN, title: 'Empty', start_angle: 0, order_index: 2 },
      ], error: null }
    }
    return { data: [], error: null } // hotspots
  })
  const spins = await publicVehicleSpins({ supabase: sb } as any, SPACE_ID)
  assert.deepEqual(spins.map((s: any) => s.title), ['Roof up', 'Roof down'])
  assert.deepEqual(spins[0].views.map((v: any) => v.id), ['v1', 'v3'])
  assert.deepEqual(spins[1].views.map((v: any) => v.id), ['v2'])
  assert.equal(spins[1].start_angle, 90)
})

test('public spins before the migration: every photo in one Exterior spin', async () => {
  const sb = supabaseStub(({ table, columns }) => {
    if (table === 'vehicle_views' && columns.includes('spin_id')) return { data: null, error: { code: '42703', message: 'column vehicle_views.spin_id does not exist' } }
    if (table === 'vehicle_views') return { data: [view('v1', 0, null), view('v2', 90, null)], error: null }
    if (table === 'vehicle_spins') return { data: null, error: { code: 'PGRST205', message: 'Could not find the table' } }
    return { data: [], error: null }
  })
  const spins = await publicVehicleSpins({ supabase: sb } as any, SPACE_ID)
  assert.equal(spins.length, 1)
  assert.equal(spins[0].title, 'Exterior')
  assert.equal(spins[0].views.length, 2)
})

test('public spins: a broken table never breaks the tour', async () => {
  const sb = supabaseStub(() => ({ data: null, error: { code: 'XX000', message: 'boom' } }))
  assert.deepEqual(await publicVehicleSpins({ supabase: sb } as any, SPACE_ID), [])
})

async function buildApp(supabase: any) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = { sub: 'user-1' } })
  app.decorate('supabase', supabase)
  app.decorate('redis', null as any)
  await app.register(vehicleViewRoutes)
  return app
}

function ownerStub(spins: any[], extra?: (ctx: Ctx) => any) {
  return supabaseStub((ctx) => {
    const hit = extra?.(ctx)
    if (hit) return hit
    if (ctx.table === 'subscriptions') return { data: { status: 'active', plans: { slug: 'pro' } }, error: null }
    if (ctx.table === 'properties') return { data: { id: SPACE_ID }, error: null }
    if (ctx.table === 'vehicle_views') return { data: [], error: null }
    if (ctx.table === 'vehicle_spins' && ctx.op === 'select') return { data: spins, error: null }
    if (ctx.table === 'vehicle_spins' && ctx.op === 'insert') return { data: { id: SPIN_B, title: 'Roof down', start_angle: 0, order_index: spins.length }, error: null }
    return { data: null, error: null }
  })
}

test('adding a photo to another car\'s spin is refused', async () => {
  const app = await buildApp(ownerStub([{ id: SPIN_A, title: 'Exterior', start_angle: 0, order_index: 0 }]))
  const res = await app.inject({
    method: 'POST',
    url: `/spaces/${SPACE_ID}/vehicle-views`,
    payload: { spin_id: OTHER_SPIN, image_url: 'https://cdn.example.com/a.jpg', angle: 0 },
  })
  assert.equal(res.statusCode, 404)
  assert.match(res.json().statusMessage, /Spin not found/)
})

test('spin titles are validated', async () => {
  const app = await buildApp(ownerStub([]))
  const res = await app.inject({ method: 'POST', url: `/spaces/${SPACE_ID}/vehicle-spins`, payload: { title: '   ' } })
  assert.equal(res.statusCode, 400)
})

test('the spin limit is enforced', async () => {
  const full = Array.from({ length: MAX_VEHICLE_SPINS }, (_, i) => ({ id: `${SPIN_A.slice(0, -1)}${i}`, title: `S${i}`, start_angle: 0, order_index: i }))
  const app = await buildApp(ownerStub(full))
  const res = await app.inject({ method: 'POST', url: `/spaces/${SPACE_ID}/vehicle-spins`, payload: { title: 'Doors open' } })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().statusMessage, /Up to 6 spins/)
})

test('start angle must be a whole degree in 0-359', async () => {
  const app = await buildApp(ownerStub([]))
  const res = await app.inject({ method: 'PATCH', url: `/vehicle-spins/${SPIN_A}`, payload: { start_angle: 400 } })
  assert.equal(res.statusCode, 400)
})
