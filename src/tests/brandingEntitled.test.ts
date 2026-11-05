import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brandingEntitled } from '../utils/quotas.js'

// checkUserQuota reads the billing:status Redis cache first, so a stub Redis
// is enough to drive every plan/status case without a database.
function fakeFastify(cached: unknown | null, opts: { dbThrows?: boolean } = {}) {
  const warnings: unknown[] = []
  const fastify: any = {
    redis: { get: async () => (cached === null ? null : JSON.stringify(cached)) },
    log: { warn: (o: unknown) => warnings.push(o) },
    supabase: {
      from: () => {
        if (opts.dbThrows) throw new Error('db down')
        throw new Error('unexpected db call')
      },
    },
  }
  return { fastify, warnings }
}

const paid = { branding_customization_enabled: true, name: 'Pro' }
const free = { branding_customization_enabled: false, name: 'Free' }

test('active paid plan keeps white-label', async () => {
  const { fastify } = fakeFastify({ subscription: { status: 'active' }, plan: paid })
  assert.equal(await brandingEntitled(fastify, 'u1'), true)
})

test('downgraded to a plan without branding loses white-label', async () => {
  const { fastify } = fakeFastify({ subscription: { status: 'active' }, plan: free })
  assert.equal(await brandingEntitled(fastify, 'u1'), false)
})

test('expired subscription on a paid plan loses white-label', async () => {
  const { fastify } = fakeFastify({ subscription: { status: 'expired' }, plan: paid })
  assert.equal(await brandingEntitled(fastify, 'u1'), false)
})

test('grace period still counts as paid', async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString()
  const { fastify } = fakeFastify({ subscription: { status: 'grace_period', grace_period_ends_at: future }, plan: paid })
  assert.equal(await brandingEntitled(fastify, 'u1'), true)
})

test('grace period that has ended loses white-label', async () => {
  const past = new Date(Date.now() - 86_400_000).toISOString()
  const { fastify } = fakeFastify({ subscription: { status: 'grace_period', grace_period_ends_at: past }, plan: paid })
  assert.equal(await brandingEntitled(fastify, 'u1'), false)
})

test('plan unreadable returns null (callers keep the stored flag) and logs', async () => {
  const { fastify, warnings } = fakeFastify(null, { dbThrows: true })
  assert.equal(await brandingEntitled(fastify, 'u1'), null)
  assert.equal(warnings.length, 1)
})
