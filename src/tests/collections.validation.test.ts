import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import collectionRoutes from '../routes/collections.js'

function app() {
  const fastify = Fastify()
  fastify.decorate('authenticate', async (request: any) => {
    request.user = { sub: '11111111-1111-4111-8111-111111111111' }
  })
  // Invalid requests tested below must be refused before any database call.
  fastify.decorate('supabase', { from: () => { throw new Error('Database should not be queried') } } as any)
  fastify.register(collectionRoutes)
  return fastify
}

test('showcase public slugs reject unsafe input', async () => {
  const server = app()
  const response = await server.inject({ method: 'GET', url: '/showcases/unsafe%20slug' })
  assert.equal(response.statusCode, 400)
  await server.close()
})

test('a showcase refuses duplicate tours before writing', async () => {
  const server = app()
  const id = '22222222-2222-4222-8222-222222222222'
  const response = await server.inject({
    method: 'POST',
    url: '/collections',
    payload: { title: 'Client shortlist', property_ids: [id, id] },
  })
  assert.equal(response.statusCode, 400)
  assert.match(response.json().statusMessage, /once/i)
  await server.close()
})
