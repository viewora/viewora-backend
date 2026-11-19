import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import analyticsRoutes, { VisitEventsBody } from '../routes/analytics.js'
import { summarizeVisits, type VisitEventRow } from '../utils/visitInsights.js'

const SPACE = '11111111-1111-4111-8111-111111111111'
const J1 = '44444444-4444-4444-8444-444444444444'
const RECEPTION = '22222222-2222-4222-8222-222222222222'
const LAB = '33333333-3333-4333-8333-333333333333'

let t = 0
function ev(session: string, event: string, extra: Partial<VisitEventRow> = {}): VisitEventRow {
  t++
  return { space_id: SPACE, visitor_id: `v-${session}`, session_id: session, event, created_at: `2026-11-19T10:00:${String(t).padStart(2, '0')}Z`, ...extra }
}

const journeys = [{ id: J1, title: 'Outpatient visit', steps: [{ title: 'Entrance' }, { title: 'Reception' }, { title: 'Lab' }] }]
const names = new Map([[RECEPTION, 'Reception'], [LAB, 'Laboratory']])
const NOW = new Date('2026-11-19T12:00:00Z')

test('visits: starts, completion, and where people stopped watching', () => {
  const rows = [
    ev('a', 'tour_open', { meta: { device: 'phone' } }),
    ev('a', 'visit_start', { journey_id: J1 }),
    ev('a', 'step_reached', { journey_id: J1, step: 0 }),
    ev('a', 'step_reached', { journey_id: J1, step: 1 }),
    ev('a', 'step_reached', { journey_id: J1, step: 2 }),
    ev('a', 'visit_complete', { journey_id: J1, value: 120000 }),
    // Watch again in the same session: still one start, one finish.
    ev('a', 'visit_start', { journey_id: J1 }),
    ev('a', 'visit_complete', { journey_id: J1, value: 100000 }),
    ev('b', 'tour_open', { meta: { device: 'desktop' } }),
    ev('b', 'visit_start', { journey_id: J1 }),
    ev('b', 'step_reached', { journey_id: J1, step: 0 }),
    ev('b', 'step_reached', { journey_id: J1, step: 1 }),
    ev('b', 'visit_exit', { journey_id: J1, step: 1 }),
    ev('c', 'tour_open', { meta: { device: 'phone' } }),
    ev('c', 'session_end', { value: 30000 }),
    ev('a', 'session_end', { value: 90000 }),
  ]
  const s = summarizeVisits(rows, journeys, names, 7, NOW)
  assert.equal(s.sessions, 3)
  assert.equal(s.visitors, 3)
  assert.deepEqual(s.devices, { phone: 2, tablet: 0, desktop: 1 })
  assert.equal(s.medianSessionMs, 60000)
  assert.equal(Math.round(s.guidedShare * 100), 67)
  const v = s.visits[0]!
  assert.equal(v.title, 'Outpatient visit')
  assert.equal(v.starts, 2)
  assert.equal(v.completes, 1)
  assert.equal(v.completionRate, 0.5)
  assert.equal(v.medianMs, 110000)
  assert.deepEqual(v.steps.map(x => x.reached), [2, 2, 1])
  assert.equal(v.topExitStep, 1, 'b left at Reception')
  assert.equal(s.daily.length, 7)
  assert.equal(s.daily.at(-1)!.sessions, 3)
})

test('areas, photos and directions', () => {
  const rows = [
    ev('a', 'area_open', { scene_id: RECEPTION }),
    ev('a', 'area_complete', { scene_id: RECEPTION }),
    ev('b', 'area_open', { scene_id: RECEPTION }),
    ev('b', 'scene_view', { scene_id: LAB }),
    ev('b', 'scene_view', { scene_id: LAB }),
    ev('b', 'scene_view', { scene_id: RECEPTION }),
    ev('a', 'route_start', { scene_id: LAB, meta: { from: RECEPTION } }),
    ev('a', 'route_arrive', { scene_id: LAB }),
    ev('b', 'route_start', { scene_id: LAB, meta: { from: RECEPTION } }),
    // b changed their mind: arriving at Reception doesn't count for the Lab route.
    ev('b', 'route_start', { scene_id: RECEPTION }),
    ev('b', 'route_arrive', { scene_id: LAB }),
  ]
  const s = summarizeVisits(rows, [], names, 7, NOW)
  assert.deepEqual(s.areas, [{ scene_id: RECEPTION, title: 'Reception', opens: 2, completes: 1 }])
  assert.deepEqual(s.scenes.map(x => [x.title, x.views]), [['Laboratory', 2], ['Reception', 1]])
  const lab = s.routes.find(r => r.to === LAB)!
  assert.deepEqual([lab.fromTitle, lab.toTitle, lab.asks, lab.arrived], ['Reception', 'Laboratory', 2, 1])
  const rec = s.routes.find(r => r.to === RECEPTION)!
  assert.deepEqual([rec.fromTitle, rec.asks, rec.arrived], ['Where they were', 1, 0])
})

test('no events: zeros, never a crash', () => {
  const s = summarizeVisits([], journeys, names, 30, NOW)
  assert.equal(s.sessions, 0)
  assert.equal(s.medianSessionMs, null)
  assert.equal(s.guidedShare, 0)
  assert.equal(s.visits[0]!.starts, 0)
  assert.equal(s.daily.length, 30)
})

test('event batch schema: only known events and the two meta keys', () => {
  const ok = VisitEventsBody.safeParse({
    spaceId: SPACE, visitorId: 'visitor-abc123', sessionId: 'session-xyz789',
    events: [{ event: 'route_start', sceneId: LAB, meta: { from: RECEPTION } }],
  })
  assert.ok(ok.success)
  assert.ok(!VisitEventsBody.safeParse({ spaceId: SPACE, visitorId: 'visitor-abc123', sessionId: 'session-xyz789', events: [{ event: 'hack' }] }).success)
  assert.ok(!VisitEventsBody.safeParse({ spaceId: SPACE, visitorId: 'visitor-abc123', sessionId: 'session-xyz789', events: [] }).success)
  const extra = VisitEventsBody.parse({ spaceId: SPACE, visitorId: 'visitor-abc123', sessionId: 'session-xyz789', events: [{ event: 'tour_open', meta: { device: 'phone', name: 'Jane' } as any }] })
  assert.deepEqual(extra.events[0]!.meta, { device: 'phone' }, 'unknown meta keys are stripped')
})

function stub(writes: any[], opts: { missing?: boolean } = {}) {
  return {
    from(table: string) {
      const b: any = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit']) b[m] = () => b
      b.insert = (row: any) => { writes.push({ table, row }); return b }
      b.maybeSingle = async () => ({ data: table === 'properties' ? { id: SPACE } : null, error: null })
      b.then = (resolve: any, reject: any) => {
        if (table === 'visit_events' && opts.missing) return Promise.resolve({ data: null, error: { code: 'PGRST205', message: 'visit_events not in schema cache' } }).then(resolve, reject)
        const data = table === 'properties' ? [{ id: SPACE, title: 'Halcyon' }] : []
        return Promise.resolve({ data, error: null }).then(resolve, reject)
      }
      return b
    },
  }
}

async function app(supabase: any) {
  const a = Fastify()
  a.decorate('authenticate', async (req: any, reply: any) => {
    if (!req.headers.authorization) return reply.code(401).send({})
    req.user = { sub: 'user-1' }
  })
  a.decorate('supabase', supabase)
  await a.register(analyticsRoutes, { prefix: '/analytics' })
  return a
}

test('POST /analytics/events accepts a beacon (text/plain) batch', async () => {
  const writes: any[] = []
  const a = await app(stub(writes))
  const res = await a.inject({
    method: 'POST', url: '/analytics/events',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    payload: JSON.stringify({ spaceId: SPACE, visitorId: 'visitor-abc123', sessionId: 'session-xyz789', events: [{ event: 'scene_view', sceneId: LAB }, { event: 'session_end', value: 5000 }] }),
  })
  assert.equal(res.statusCode, 204)
  const rows = writes.find(w => w.table === 'visit_events')!.row
  assert.equal(rows.length, 2)
  assert.equal(rows[0].scene_id, LAB)
  assert.equal(rows[1].value, 5000)
  assert.equal(rows[0].meta, null)
  await a.close()
})

test('GET /analytics/visits says when the migration has not run', async () => {
  const a = await app(stub([], { missing: true }))
  const res = await a.inject({ method: 'GET', url: '/analytics/visits?days=30', headers: { authorization: 'Bearer x' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().enabled, false)
  assert.equal(res.json().daily.length, 30)
  await a.close()
})

test("photos are named as the tour's area list names them", async () => {
  const { placeNames } = await import('../utils/visitInsights.js')
  const names = placeNames(
    [{ id: RECEPTION, name: 'IMG 002' }, { id: LAB, name: 'Lab photo' }, { id: 'x', name: '' }],
    [{ steps: [{ title: '', scene_id: LAB }, { title: 'Reception', scene_id: RECEPTION }] }, { steps: [{ title: 'Front desk', scene_id: RECEPTION }] }],
  )
  assert.equal(names.get(RECEPTION), 'Reception')
  assert.equal(names.get(LAB), 'Lab photo')
  assert.equal(names.get('x'), 'Untitled photo')
})
