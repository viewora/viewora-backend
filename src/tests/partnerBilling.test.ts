import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncAgentSubscription } from '../partners/billing.js'

// Fake Supabase with one subscriptions table.
function fake(existing: Record<string, any> | null) {
  const writes: { op: string; row: any }[] = []
  const deleted: string[] = []
  const subscriptions = {
    select() { return this },
    eq() { return this },
    maybeSingle: async () => ({ data: existing, error: null }),
    update(row: any) { writes.push({ op: 'update', row }); return { eq: async () => ({ error: null }) } },
    insert: async (row: any) => { writes.push({ op: 'insert', row }); return { error: null } },
  }
  const fastify: any = {
    supabase: { from: (t: string) => { assert.equal(t, 'subscriptions'); return subscriptions } },
    redis: { del: async (k: string) => { deleted.push(k) } },
    log: { error() {} },
  }
  return { fastify, writes, deleted }
}

const PAID = { agent_plan_id: 'pro', paid_until: '2099-01-01T00:00:00.000Z' }

test('an agent with no subscription gets the partner plan until paid_until', async () => {
  const f = fake(null)
  assert.equal(await syncAgentSubscription(f.fastify, PAID, 'u1'), 'synced')
  assert.equal(f.writes[0].op, 'insert')
  assert.equal(f.writes[0].row.plan_id, 'pro')
  assert.equal(f.writes[0].row.status, 'active')
  assert.equal(f.writes[0].row.provider, 'manual')
  assert.equal(f.writes[0].row.current_period_end, PAID.paid_until)
  assert.deepEqual(f.deleted, ['billing:status:u1'])
})

test('a partner-managed subscription is updated in place', async () => {
  const f = fake({ id: 's1', provider: 'manual' })
  assert.equal(await syncAgentSubscription(f.fastify, PAID, 'u1'), 'synced')
  assert.equal(f.writes[0].op, 'update')
})

test('an agent who pays for themselves is never overwritten', async () => {
  const f = fake({ id: 's1', provider: 'paystack' })
  assert.equal(await syncAgentSubscription(f.fastify, PAID, 'u1'), 'skipped_self_paid')
  assert.equal(f.writes.length, 0)
})

test('a partner with no plan leaves agents on Free', async () => {
  const f = fake(null)
  assert.equal(await syncAgentSubscription(f.fastify, { agent_plan_id: null, paid_until: null }, 'u1'), 'skipped_no_plan')
  assert.equal(f.writes.length, 0)
})

test('when the partner has stopped paying, agents are marked expired', async () => {
  const f = fake({ id: 's1', provider: 'manual' })
  await syncAgentSubscription(f.fastify, { agent_plan_id: 'pro', paid_until: '2020-01-01T00:00:00.000Z' }, 'u1')
  assert.equal(f.writes[0].row.status, 'expired')
})
