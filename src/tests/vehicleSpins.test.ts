import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import vehicleViewRoutes, { publicVehicleSpins, MAX_VEHICLE_SPINS } from '../routes/vehicleViews.js'

const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const SPIN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SPIN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_SPIN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

type Ctx = { table: string; op: string; columns: string; filters: Record<string, unknown>; selected?: string; payload?: any }

// Chainable query-builder stub that remembers the selected columns and eq() filters,
// so a test can answer "no such column" the way PostgREST does before a migration.
function supabaseStub(result: (ctx: Ctx) => { data: unknown; error: unknown; count?: number }) {
  return {
    from(table: string) {
      const ctx: Ctx = { table, op: 'select', columns: '', filters: {} }
      const builder: any = {}
      builder.select = (cols?: string) => { if (ctx.op === 'select') ctx.columns = cols ?? ''; ctx.selected = cols ?? ''; return builder }
      builder.eq = (k: string, v: unknown) => { ctx.filters[k] = v; return builder }
      for (const m of ['in', 'or', 'order', 'limit']) builder[m] = () => builder
      for (const m of ['insert', 'update', 'delete']) builder[m] = (payload?: any) => { ctx.op = m; ctx.payload = payload; return builder }
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

test('public spins: camera-height rows ride inside their main spin', async () => {
  const ROW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const sb = supabaseStub(({ table }) => {
    if (table === 'vehicle_views') return { data: [view('v1', 0, SPIN_A), view('v2', 0, ROW), view('v3', 0, SPIN_B)], error: null }
    if (table === 'vehicle_spins') {
      return { data: [
        { id: SPIN_A, title: 'Roof up', start_angle: 0, order_index: 0, row_of: null, elevation: 0 },
        { id: ROW, title: 'Roof up · high', start_angle: 0, order_index: 1, row_of: SPIN_A, elevation: 30 },
        { id: SPIN_B, title: 'Roof down', start_angle: 0, order_index: 2, row_of: null, elevation: 0 },
      ], error: null }
    }
    return { data: [], error: null }
  })
  const spins: any[] = await publicVehicleSpins({ supabase: sb } as any, SPACE_ID)
  assert.deepEqual(spins.map((s: any) => s.title), ['Roof up', 'Roof down'])
  assert.equal(spins[0].rows.length, 1)
  assert.equal(spins[0].rows[0].elevation, 30)
  assert.deepEqual(spins[0].rows[0].views.map((v: any) => v.id), ['v2'])
  assert.equal(spins[1].rows, undefined)
})

test('a height row cannot hang off another height row', async () => {
  const ROW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const app = await buildApp(ownerStub([
    { id: SPIN_A, title: 'Exterior', start_angle: 0, order_index: 0, row_of: null, elevation: 0 },
    { id: ROW, title: 'Exterior · high', start_angle: 0, order_index: 1, row_of: SPIN_A, elevation: 30 },
  ]))
  const res = await app.inject({ method: 'POST', url: `/spaces/${SPACE_ID}/vehicle-spins`, payload: { title: 'Higher still', row_of: ROW } })
  assert.equal(res.statusCode, 400)
})

test('a height row before its migration names the file to run', async () => {
  const app = await buildApp(ownerStub([{ id: SPIN_A, title: 'Exterior', start_angle: 0, order_index: 0 }], (ctx) => (
    ctx.table === 'vehicle_spins' && ctx.op === 'insert'
      ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'row_of' column of 'vehicle_spins'" } }
      : null
  )))
  const res = await app.inject({ method: 'POST', url: `/spaces/${SPACE_ID}/vehicle-spins`, payload: { title: 'Exterior · high', row_of: SPIN_A, elevation: 30 } })
  assert.equal(res.statusCode, 503)
  assert.match(res.json().statusMessage, /migration-vehicle-spin-rows\.sql/)
})

const HOTSPOT_MISSING = { code: '42703', message: 'column vehicle_hotspots.image_url does not exist' }

test('public spins: hotspots carry their photo', async () => {
  const sb = supabaseStub(({ table }) => {
    if (table === 'vehicle_views') return { data: [view('v1', 0, SPIN_A)], error: null }
    if (table === 'vehicle_spins') return { data: [{ id: SPIN_A, title: 'Exterior', start_angle: 0, order_index: 0, row_of: null, elevation: 0 }], error: null }
    if (table === 'vehicle_hotspots') return { data: [{ id: 'h1', view_id: 'v1', kind: 'feature', x: 0.5, y: 0.4, title: 'Engine', body: null, url: null, image_url: 'https://cdn.example.com/engine.jpg' }], error: null }
    return { data: null, error: null }
  })
  const spins = await publicVehicleSpins({ supabase: sb } as any, SPACE_ID)
  assert.equal(spins[0].views[0].hotspots[0].image_url, 'https://cdn.example.com/engine.jpg')
})

test('public spins before the hotspot photo migration: hotspots still load', async () => {
  const sb = supabaseStub(({ table, columns }) => {
    if (table === 'vehicle_views') return { data: [view('v1', 0, SPIN_A)], error: null }
    if (table === 'vehicle_spins') return { data: [{ id: SPIN_A, title: 'Exterior', start_angle: 0, order_index: 0, row_of: null, elevation: 0 }], error: null }
    if (table === 'vehicle_hotspots') {
      if (columns.includes('image_url')) return { data: null, error: HOTSPOT_MISSING }
      return { data: [{ id: 'h1', view_id: 'v1', kind: 'feature', x: 0.5, y: 0.4, title: 'Engine', body: null, url: null }], error: null }
    }
    return { data: null, error: null }
  })
  const spins = await publicVehicleSpins({ supabase: sb } as any, SPACE_ID)
  assert.equal(spins[0].views[0].hotspots.length, 1)
  assert.equal(spins[0].views[0].hotspots[0].title, 'Engine')
})

const HOTSPOT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const VIEW_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const TRACK_MISSING = { code: 'PGRST204', message: "Could not find the 'track' column of 'vehicle_hotspots' in the schema cache" }

// The hotspot table before the track migration: any write or read that names `track` fails like PostgREST.
function hotspotStub(trackColumn: boolean) {
  const writes: any[] = []
  const sb = supabaseStub((ctx) => {
    if (ctx.table === 'subscriptions') return { data: { status: 'active', plans: { slug: 'pro' } }, error: null }
    if (ctx.table !== 'vehicle_hotspots') return { data: null, error: null }
    if (ctx.op === 'select' && ctx.selected?.includes('properties!inner')) return { data: { id: HOTSPOT_ID, space_id: SPACE_ID }, error: null }
    const named = (ctx.selected ?? '').includes('track') || (ctx.payload && 'track' in ctx.payload)
    if (!trackColumn && named) return { data: null, error: TRACK_MISSING }
    if (ctx.op === 'update') writes.push(ctx.payload)
    return { data: { id: HOTSPOT_ID, view_id: VIEW_A, kind: 'feature', x: 0.5, y: 0.5, title: 'Bonnet', ...(ctx.payload ?? {}) }, error: null }
  })
  return { sb, writes }
}

const TRACK = { pts: { [VIEW_A]: [0.5, 0.42] as [number, number] }, fixed: [], v: 2 }

test('a pin saves where it sits on each frame', async () => {
  const { sb, writes } = hotspotStub(true)
  const app = await buildApp(sb)
  const res = await app.inject({ method: 'PATCH', url: `/vehicle-hotspots/${HOTSPOT_ID}`, payload: { track: TRACK } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(writes[0].track, TRACK)
})

test('before the track migration: saving a track names the file to run', async () => {
  const { sb } = hotspotStub(false)
  const app = await buildApp(sb)
  const res = await app.inject({ method: 'PATCH', url: `/vehicle-hotspots/${HOTSPOT_ID}`, payload: { track: TRACK } })
  assert.equal(res.statusCode, 503)
  assert.match(res.json().statusMessage, /migration-vehicle-hotspot-track\.sql/)
})

test('before the track migration: other edits still save', async () => {
  const { sb, writes } = hotspotStub(false)
  const app = await buildApp(sb)
  const res = await app.inject({ method: 'PATCH', url: `/vehicle-hotspots/${HOTSPOT_ID}`, payload: { title: 'Engine' } })
  assert.equal(res.statusCode, 200)
  assert.equal(writes[0].title, 'Engine')
})

test('a track must hold fractions of the photo', async () => {
  const { sb } = hotspotStub(true)
  const app = await buildApp(sb)
  const res = await app.inject({ method: 'PATCH', url: `/vehicle-hotspots/${HOTSPOT_ID}`, payload: { track: { pts: { [VIEW_A]: [1.4, 0.2] } } } })
  assert.equal(res.statusCode, 400)
})
