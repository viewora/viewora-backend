import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import quoteRoutes from '../routes/quote.js'
import quoteAdminRoutes from '../routes/quoteAdmin.js'
import { memoryStore } from '../quote/store.js'
import { memoryAdminStore } from '../quote/adminStore.js'
import { memoryDeskStore } from '../quote/deskStore.js'
import { memoryJobStore } from '../quote/jobStore.js'
import { memoryFollowupStore } from '../quote/followupStore.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import { buildReport, nairobiRange, reportCsv, type ReportRow, type Visitors } from '../quote/reports.js'
import { posthogVisitors, type VisitorsFn } from '../quote/posthogVisitors.js'

process.env.ADMIN_SECRET = 'test-admin-secret'
const ADMIN = '00000000-0000-4000-8000-000000000001'
const SALES = '00000000-0000-4000-8000-000000000002'
const as = (who: string) => ({ authorization: 'Bearer test-admin-secret', 'x-admin-id': who })

// ── Pure rules ──────────────────────────────────────────────────────────────

let n = 0
const row = (patch: Partial<ReportRow> = {}): ReportRow => ({
  requestId: `r${++n}`, startedAt: '2026-11-02T09:00:00Z', industry: 'homes', source: 'site', stepReached: 5,
  completed: true, quoted: false, booked: false, paid: false, jobValue: null, currency: null, firstStaffMinutes: null, ...patch,
})
const none: Visitors = { status: 'not_connected', total: null, bySource: {} }

test('report: the funnel counts each stage, and each stage as a share of the one before', () => {
  const rows = [
    row({ completed: false, stepReached: 1 }), row({ completed: false, stepReached: 1 }), row({ completed: false, stepReached: 3 }),
    row({ quoted: true }), row({ quoted: true, booked: true, jobValue: 20_000, currency: 'KES' }),
    row({ quoted: true, booked: true, paid: true, jobValue: 30_000, currency: 'KES' }), row(),
  ]
  const r = buildReport(rows, { status: 'ok', total: 20, bySource: { site: 20 } })
  assert.deepEqual(r.funnel.map(f => [f.key, f.count, f.ofPrevious]), [
    ['visitors', 20, null], ['started', 7, 3_500], ['completed', 4, 5_714], ['quoted', 3, 7_500], ['booked', 2, 6_667], ['paid', 1, 5_000],
  ])
  // Unfinished forms by the last step saved: two left at step 1, one at step 3
  assert.deepEqual(r.dropOff.map(d => d.count), [2, 0, 1, 0, 0])
  assert.equal(r.kpis.winRate, 6_667)
  assert.equal(r.kpis.avgJobValue, 25_000)
})

test('report: with no visitor numbers the funnel says so instead of guessing', () => {
  const r = buildReport([row()], none)
  assert.deepEqual([r.funnel[0].count, r.funnel[1].ofPrevious], [null, null])
  const empty = buildReport([], none)
  assert.deepEqual([empty.kpis.winRate, empty.kpis.avgJobValue, empty.kpis.medianFirstStaffMinutes], [null, null, null])
  assert.deepEqual(empty.byIndustry, [])
})

test('report: industries and sources, USD jobs are counted but never averaged with shillings', () => {
  const rows = [
    row({ industry: 'cars', source: null, quoted: true, booked: true, jobValue: 15_000, currency: 'KES' }),
    row({ industry: 'cars', source: 'instagram', quoted: true }),
    row({ industry: 'homes', source: 'instagram', quoted: true, booked: true, jobValue: 50_000, currency: 'USD' }),
  ]
  const r = buildReport(rows, none)
  assert.deepEqual(r.byIndustry.map(g => [g.key, g.started, g.quoted, g.booked, g.winRate, g.avgJobValue]), [
    ['cars', 2, 2, 1, 5_000, 15_000], ['homes', 1, 1, 1, 10_000, null],
  ])
  assert.deepEqual(r.bySource.map(g => g.key), ['instagram', 'direct'])
  assert.deepEqual([r.kpis.avgJobValue, r.kpis.usdJobs], [15_000, 1])
})

test('report: median first staff action', () => {
  assert.equal(buildReport([row({ firstStaffMinutes: 5 }), row({ firstStaffMinutes: 90 }), row({ firstStaffMinutes: 12 })], none).kpis.medianFirstStaffMinutes, 12)
  assert.equal(buildReport([row({ firstStaffMinutes: 5 }), row({ firstStaffMinutes: 10 })], none).kpis.medianFirstStaffMinutes, 8)
})

test('report: Nairobi days, and a CSV a spreadsheet cannot run', () => {
  assert.deepEqual(nairobiRange('2026-11-01', '2026-11-30'), { fromIso: '2026-10-31T21:00:00.000Z', toIso: '2026-11-30T21:00:00.000Z' })
  const csv = reportCsv(buildReport([row({ industry: 'homes', source: '=cmd', quoted: true, booked: true, jobValue: 9_000, currency: 'KES' })], none))
  assert.match(csv, /^Group,Name,Started/)
  assert.match(csv, /Industry,homes,1,1,1,1,100%,9000/)
  assert.match(csv, /Source,'=cmd,/)
})

test('visitors: not connected without a key; a PostHog answer is read; a failure is said plainly', async () => {
  assert.equal((await posthogVisitors({})('a', 'b')).status, 'not_connected')
  const env = { QUOTE_POSTHOG_PERSONAL_KEY: 'phx_test', QUOTE_POSTHOG_PROJECT_ID: '123' }
  let sent: { url: string; init: RequestInit } | null = null
  const ok = (async (url: string, init: RequestInit) => {
    sent = { url, init }
    return new Response(JSON.stringify({ results: [['*', 9], ['instagram', 4], [null, 6]] }))
  }) as unknown as typeof fetch
  const v = await posthogVisitors(env, ok)('2026-10-31T21:00:00.000Z', '2026-11-30T21:00:00.000Z')
  assert.deepEqual(v, { status: 'ok', total: 9, bySource: { instagram: 4, direct: 6 } })
  assert.equal(sent!.url, 'https://us.posthog.com/api/projects/123/query/')
  assert.equal((sent!.init.headers as Record<string, string>).Authorization, 'Bearer phx_test')
  assert.match(String(sent!.init.body), /quote_form_viewed/)
  const down = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
  assert.equal((await posthogVisitors(env, down)('a', 'b')).status, 'failed')
  const offline = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  assert.equal((await posthogVisitors(env, offline)('a', 'b')).status, 'failed')
})

// ── Route over the memory store ─────────────────────────────────────────────

async function setup(visitors: VisitorsFn) {
  const clock = new Date('2026-11-20T09:00:00Z')
  const now = () => clock
  const store = memoryStore({
    rateTable: rateTableV1, consent: { id: 'c1', body: 'Consent wording' }, recipients: [], clock: now,
    staff: [
      { userId: ADMIN, displayName: 'Peter', role: 'admin', discountLimitBp: 10_000, email: null, active: true },
      { userId: SALES, displayName: 'Wanjiru', role: 'sales', discountLimitBp: 500, email: null, active: true },
    ],
  })
  const desk = memoryDeskStore(() => store.dump())
  const jobs = memoryJobStore(() => store.dump())
  const followups = memoryFollowupStore(() => store.dump())
  const alerts = { liveSend: false, extraRecipients: [], adminUrl: 'https://admin.example.com', send: async () => {} }
  const messaging = { now, publicUrl: 'https://app.example.com', optOutSecret: 'optout-test', messagesLive: false }
  const fastify = Fastify()
  await fastify.register(quoteRoutes, { prefix: '/quote', store, desk, jobs, alerts, followups, messaging, payments: { paystack: null, now } })
  await fastify.register(quoteAdminRoutes, {
    prefix: '/admin/quote', store, desk, jobs, followups, adminStore: memoryAdminStore(() => store.dump()), visitors,
    messagesLive: false, publicUrl: 'https://app.example.com', now, payments: { paystack: null, now },
  })
  const call = (url: string, who = ADMIN) => fastify.inject({ method: 'GET', url, headers: as(who) })
  const start = async (moduleKey: string, source: string) => {
    const res = await fastify.inject({ method: 'POST', url: '/quote/requests', payload: { moduleKey, entry: { source } } })
    assert.equal(res.statusCode, 201)
    return store.dump().requests.at(-1)!
  }
  return { store, call, start }
}

test('reports route: drop-off by step, filters, first staff action, and commission only for admins', async () => {
  const asked: string[] = []
  const t = await setup(async (from, to) => { asked.push(`${from} ${to}`); return { status: 'ok', total: 10, bySource: { instagram: 6, site: 4 } } })
  const a = await t.start('homes', 'instagram')
  const b = await t.start('homes', 'site')
  const c = await t.start('vehicles', 'instagram')
  b.stepReached = 3
  Object.assign(c, { stepReached: 5, completedAt: '2026-11-20T09:00:00.000Z', leadId: 'lead-c' })
  // Staff answered 25 minutes after the form was finished
  const d = t.store.dump()
  d.audit.push({ id: 99, actorId: SALES, entityType: 'lead', entityId: 'lead-c', action: 'stage', before: null, after: null, reason: null, createdAt: '2026-11-20T09:25:00.000Z' })
  d.quotes.push({ id: 'q1', requestId: c.id, sentAt: '2026-11-20T09:30:00.000Z', options: [{ tier: 'standard', net: 12_000, total: 13_920 }] } as any)
  d.jobs.push({ id: 'j1', quoteId: 'q1', leadId: 'lead-c', optionTier: 'standard', status: 'booked', currency: 'KES', balanceStatus: 'pending' } as any)

  const res = await t.call('/admin/quote/reports', SALES)
  assert.equal(res.statusCode, 200)
  const r = res.json()
  assert.deepEqual([r.from, r.to], ['2026-10-22', '2026-11-20'], 'the last 30 days by default')
  assert.equal(asked[0], '2026-10-21T21:00:00.000Z 2026-11-20T21:00:00.000Z')
  assert.deepEqual(r.funnel.map((f: any) => f.count), [10, 3, 1, 1, 1, 0])
  assert.deepEqual(r.dropOff.map((x: any) => x.count), [1, 0, 1, 0, 0], `${a.stepReached}`)
  assert.equal(r.kpis.medianFirstStaffMinutes, 25)
  assert.equal(r.kpis.avgJobValue, 12_000)
  assert.equal(r.partners, null, 'sales staff do not see commission')
  assert.ok(!JSON.stringify(r).includes('lead-c'), 'no lead ids in the report')

  const insta = (await t.call('/admin/quote/reports?source=instagram')).json()
  assert.deepEqual([insta.visitors.total, insta.funnel[1].count], [6, 2])
  assert.deepEqual(insta.choices.sources, ['instagram', 'site'], 'the other choices stay')
  assert.deepEqual(insta.partners, [])
  const cars = (await t.call('/admin/quote/reports?industry=vehicles')).json()
  assert.deepEqual([cars.visitors.status, cars.funnel[0].count, cars.funnel[1].count], ['not_by_industry', null, 1])

  // A period before any of this has nothing in it
  const old = (await t.call('/admin/quote/reports?from=2026-01-01&to=2026-01-31')).json()
  assert.equal(old.funnel[1].count, 0)
  assert.equal((await t.call('/admin/quote/reports?from=2026-02-01&to=2026-01-01')).statusCode, 400)
  assert.equal((await t.call('/admin/quote/reports?from=2024-01-01&to=2026-01-01')).statusCode, 400)
  assert.equal((await t.call('/admin/quote/reports?industry=DROP%20TABLE')).statusCode, 400)

  const csv = await t.call('/admin/quote/reports.csv?from=2026-11-01&to=2026-11-30')
  assert.equal(csv.headers['content-type'], 'text/csv; charset=utf-8')
  assert.match(String(csv.headers['content-disposition']), /quote-report-2026-11-01-to-2026-11-30\.csv/)
  assert.match(csv.body, /Industry,homes,2,0,0,0,,/)
})
