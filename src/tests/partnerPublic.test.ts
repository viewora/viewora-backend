import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import partnerPublic from '../routes/partnerPublic.js'

function app(tables: { space?: any; ref?: any }) {
  const q = (data: any) => ({ select() { return this }, eq() { return this }, maybeSingle: async () => ({ data, error: null }) })
  const a = Fastify()
  a.decorate('supabase', { from: (t: string) => q(t === 'properties' ? tables.space : tables.ref) } as any)
  a.decorate('redis', null as any)
  a.register(partnerPublic)
  return a
}

test('a normal tour can be embedded anywhere', async () => {
  const a = app({ space: { id: 's1' }, ref: null })
  const res = await a.inject({ method: 'GET', url: '/embed-policy/nice-house' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { frame_ancestors: null })
})

test('a partner tour lists only the partner\'s sites', async () => {
  const a = app({ space: { id: 's1' }, ref: { api_partners: { status: 'active', allowed_embed_origins: ['https://cars.example.co.ke'] } } })
  const res = await a.inject({ method: 'GET', url: '/embed-policy/prado-2019' })
  assert.deepEqual(res.json(), { frame_ancestors: ['https://cars.example.co.ke'] })
})

test('a partner with no sites set does not restrict embedding', async () => {
  const a = app({ space: { id: 's1' }, ref: { api_partners: { status: 'active', allowed_embed_origins: [] } } })
  assert.deepEqual((await a.inject({ method: 'GET', url: '/embed-policy/x' })).json(), { frame_ancestors: null })
})

test('odd slugs are refused', async () => {
  const a = app({})
  assert.equal((await a.inject({ method: 'GET', url: '/embed-policy/a%22%3B' })).statusCode, 400)
})
