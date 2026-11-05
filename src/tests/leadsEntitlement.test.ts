import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import leadsRoutes from '../routes/leads.js'

const SPACE_ID = '11111111-1111-4111-8111-111111111111'

// A published space whose owner's plan (via the billing:status cache that
// checkUserQuota reads first) does or doesn't include lead capture.
async function buildApp(opts: { leadCapture: boolean | 'unreadable'; status?: string }) {
  let inserted = false
  const propertyRow = { id: SPACE_ID, is_published: true, lead_form_enabled: true, user_id: 'owner-1' }

  const supabase: any = {
    from(table: string) {
      if (table === 'leads') {
        return {
          insert() { inserted = true; return this },
          select() { return this },
          single: async () => ({ data: { id: 'lead-1' }, error: null }),
        }
      }
      if (table === 'properties') {
        return {
          select() { return this },
          eq() { return this },
          single: async () => ({ data: propertyRow, error: null }),
        }
      }
      // Any other table is a plan lookup: fail so "unreadable" can be tested.
      throw new Error('db unavailable')
    },
    rpc: async () => ({ data: null, error: null }),
    auth: { admin: { getUserById: async () => ({ data: null, error: new Error('skip') }) } },
  }

  const redis: any = opts.leadCapture === 'unreadable'
    ? null
    : {
        get: async () => JSON.stringify({
          subscription: { status: opts.status ?? 'active' },
          plan: { lead_capture_enabled: opts.leadCapture, branding_customization_enabled: false },
        }),
      }

  const app = Fastify()
  app.decorate('authenticate', async () => {})
  app.decorate('supabase', supabase)
  app.decorate('redis', redis)
  await app.register(leadsRoutes)
  return { app, wasInserted: () => inserted }
}

const formLead = { spaceId: SPACE_ID, name: 'Jane', email: 'jane@mail.com', source: 'direct' }

test('form lead is accepted while the owner plan includes lead capture', async () => {
  const { app, wasInserted } = await buildApp({ leadCapture: true })
  const res = await app.inject({ method: 'POST', url: '/', payload: formLead })
  assert.equal(res.statusCode, 201, res.body)
  assert.equal(wasInserted(), true)
  await app.close()
})

test('form lead is refused after a downgrade, and nothing is saved', async () => {
  const { app, wasInserted } = await buildApp({ leadCapture: false })
  const res = await app.inject({ method: 'POST', url: '/', payload: formLead })
  assert.equal(res.statusCode, 403, res.body)
  assert.equal(wasInserted(), false)
  await app.close()
})

test('form lead is refused when the subscription has expired', async () => {
  const { app } = await buildApp({ leadCapture: true, status: 'expired' })
  const res = await app.inject({ method: 'POST', url: '/', payload: formLead })
  assert.equal(res.statusCode, 403, res.body)
  await app.close()
})

test('WhatsApp click leads still work after a downgrade', async () => {
  const { app, wasInserted } = await buildApp({ leadCapture: false })
  const res = await app.inject({ method: 'POST', url: '/', payload: { spaceId: SPACE_ID, source: 'whatsapp' } })
  assert.equal(res.statusCode, 201, res.body)
  assert.equal(wasInserted(), true)
  await app.close()
})

test('a lead is never lost when the plan cannot be read', async () => {
  const { app, wasInserted } = await buildApp({ leadCapture: 'unreadable' })
  const res = await app.inject({ method: 'POST', url: '/', payload: formLead })
  assert.equal(res.statusCode, 201, res.body)
  assert.equal(wasInserted(), true)
  await app.close()
})
