import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import carTourRoutes, { galleryWithCaptions } from '../routes/carTour.js'

const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const MEDIA_ID = '22222222-2222-4222-8222-222222222222'

type Ctx = { table: string; op: string; columns: string }
function supabaseStub(result: (ctx: Ctx) => { data: unknown; error: unknown }) {
  return {
    from(table: string) {
      const ctx: Ctx = { table, op: 'select', columns: '' }
      const b: any = {}
      b.select = (cols?: string) => { if (ctx.op === 'select') ctx.columns = cols ?? ''; return b }
      for (const m of ['eq', 'in', 'or', 'order', 'limit']) b[m] = () => b
      for (const m of ['insert', 'update', 'delete']) b[m] = () => { ctx.op = m; return b }
      b.single = async () => result(ctx)
      b.maybeSingle = async () => result(ctx)
      b.then = (res: any, rej: any) => Promise.resolve(result(ctx)).then(res, rej)
      return b
    },
  }
}

test('gallery photos still come back, unnamed, before the caption migration', async () => {
  const sb = supabaseStub(({ columns }) => {
    if (columns.includes('caption')) return { data: null, error: { code: '42703', message: 'column property_media.caption does not exist' } }
    return { data: [{ id: 'p1', public_url: 'https://cdn.example.com/1.jpg', is_primary: true, sort_order: 0, processing_status: 'complete' }], error: null }
  })
  const g = await galleryWithCaptions({ supabase: sb } as any, SPACE_ID)
  assert.equal(g.captionsReady, false)
  assert.deepEqual(g.photos.map(p => [p.id, p.caption]), [['p1', null]])
})

test('gallery photos carry their names after the migration', async () => {
  const sb = supabaseStub(({ columns }) => {
    if (columns === 'id, caption') return { data: [{ id: 'p1', caption: 'Wheels' }], error: null }
    return { data: [{ id: 'p1', public_url: 'https://cdn.example.com/1.jpg', is_primary: true, sort_order: 0, processing_status: 'complete' }], error: null }
  })
  const g = await galleryWithCaptions({ supabase: sb } as any, SPACE_ID)
  assert.equal(g.captionsReady, true)
  assert.equal(g.photos[0].caption, 'Wheels')
})

async function buildApp(supabase: any) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = { sub: 'user-1' } })
  app.decorate('supabase', supabase)
  app.decorate('redis', null as any)
  await app.register(carTourRoutes)
  return app
}

test('a photo name longer than 40 characters is refused', async () => {
  const app = await buildApp(supabaseStub(() => ({ data: { id: SPACE_ID }, error: null })))
  const res = await app.inject({
    method: 'PATCH', url: `/spaces/${SPACE_ID}/photos/${MEDIA_ID}/caption`, payload: { caption: 'x'.repeat(41) },
  })
  assert.equal(res.statusCode, 400)
})

test('naming a photo before the migration says which file to run', async () => {
  const app = await buildApp(supabaseStub(({ table, op }) => {
    if (table === 'properties') return { data: { id: SPACE_ID }, error: null }
    if (op === 'update') return { data: null, error: { code: '42703', message: 'column "caption" does not exist' } }
    return { data: null, error: null }
  }))
  const res = await app.inject({
    method: 'PATCH', url: `/spaces/${SPACE_ID}/photos/${MEDIA_ID}/caption`, payload: { caption: 'Wheels' },
  })
  assert.equal(res.statusCode, 503)
  assert.match(res.json().statusMessage, /migration-car-tour-photos\.sql/)
})

test('car setup summary counts frames per spin, interior scenes and detail photos', async () => {
  const app = await buildApp(supabaseStub(({ table, columns }) => {
    if (table === 'properties') return { data: { id: SPACE_ID, title: 'Porsche 911', slug: 'porsche-911', is_published: true, vehicle_year: 2021 }, error: null }
    if (table === 'vehicle_views') return { data: [{ id: 'v1', spin_id: 'sA' }, { id: 'v2', spin_id: 'sA' }, { id: 'v3', spin_id: 'sB' }], error: null }
    if (table === 'vehicle_spins') return { data: [{ id: 'sA', title: 'Roof up' }, { id: 'sB', title: 'Roof down' }], error: null }
    if (table === 'scenes') return { data: [{ id: 's1', thumbnail_url: 'x' }, { id: 's2', thumbnail_url: null }], error: null }
    if (columns === 'id, caption') return { data: [{ id: 'p1', caption: 'Hood' }], error: null }
    return { data: [{ id: 'p1', public_url: 'u', processing_status: 'complete' }], error: null }
  }))
  const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE_ID}/car-setup` })
  assert.equal(res.statusCode, 200)
  const b = res.json()
  assert.deepEqual(b.spins.map((s: any) => [s.title, s.frames]), [['Roof up', 2], ['Roof down', 1]])
  assert.equal(b.interior_scenes, 2)
  assert.equal(b.interior_ready, 1)
  assert.equal(b.detail_photos[0].caption, 'Hood')
  assert.equal(b.vehicle.year, 2021)
})
