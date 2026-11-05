import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import publicRoutes from '../routes/public.js'

const SPACE_ID = '22222222-2222-4222-8222-222222222222'
const DELAY_MS = 120

// A chainable query stub: every builder method returns itself, awaiting it (or
// maybeSingle/single) resolves after DELAY_MS with canned rows per table.
function builder(table: string, log: string[]) {
  const rows: Record<string, any> = {
    property_media: [{ id: 'm1', public_url: 'https://cdn/x.jpg', is_primary: true, sort_order: 1 }],
    properties: { user_id: 'owner-1', profiles: { id: 'owner-1', full_name: 'Jane Seller' } },
    scenes: [{ id: 's1', group_name: 'Downstairs', floor_plan_id: 'fp1', plan_x: 1, plan_y: 2, north_offset: 0 }],
  }
  const settle = () => {
    log.push(table)
    return new Promise((resolve) => setTimeout(() => resolve({ data: rows[table] ?? [], error: null }), DELAY_MS))
  }
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (res: any, rej: any) => settle().then(res, rej)
      if (prop === 'maybeSingle' || prop === 'single') return () => settle()
      return () => b
    },
  })
  return b
}

async function buildApp() {
  const queries: string[] = []
  const tour = {
    space: { id: SPACE_ID, slug: 'demo-tour', title: 'Demo', property_type: 'residential', branding_enabled: false, lead_form_enabled: false },
    scenes: [{ id: 's1', name: 'Hall' }],
  }
  const supabase: any = {
    rpc: async () => ({ data: JSON.parse(JSON.stringify(tour)), error: null }),
    from: (table: string) => builder(table, queries),
  }
  const app = Fastify()
  app.decorate('authenticate', async () => {})
  app.decorate('supabase', supabase)
  app.decorate('redis', null)
  await app.register(publicRoutes)
  return { app, queries }
}

test('public tour response keeps its shape', async () => {
  const { app } = await buildApp()
  const res = await app.inject({ method: 'GET', url: '/p/demo-tour' })
  assert.equal(res.statusCode, 200, res.body)
  const { tour } = res.json()
  assert.equal(tour.gallery.length, 1)
  assert.equal(tour.gallery[0].url, 'https://cdn/x.jpg')
  assert.equal(tour.seller.full_name, 'Jane Seller')
  assert.ok(Array.isArray(tour.aerial_maps))
  assert.ok(Array.isArray(tour.floor_plans))
  assert.equal(tour.scenes[0].group_name, 'Downstairs')
  assert.equal(tour.space.space_type, 'residential')
  assert.equal('user_id' in tour.space, false, 'owner id must never be sent to the browser')
  await app.close()
})

test('independent lookups run in parallel, not one after another', async () => {
  const { app, queries } = await buildApp()
  const t0 = Date.now()
  const res = await app.inject({ method: 'GET', url: '/p/demo-tour' })
  const took = Date.now() - t0
  assert.equal(res.statusCode, 200, res.body)
  // At least gallery, owner, aerial, floor plans and scene groups were queried.
  assert.ok(queries.length >= 5, `expected 5+ queries, saw ${queries.length}`)
  // One at a time would be 5 x 120 ms = 600+ ms. In parallel it is about one delay.
  assert.ok(took < DELAY_MS * 3.5, `took ${took} ms, queries look sequential`)
  await app.close()
})
