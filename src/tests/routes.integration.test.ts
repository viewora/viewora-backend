import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import uploadsRoutes from '../routes/uploads.js'
import leadsRoutes from '../routes/leads.js'
import spacesRoutes from '../routes/spaces.js'

type SupabaseMock = {
  from: (table: string) => any
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
}

const VALID_SPACE_ID = '11111111-1111-4111-8111-111111111111'

function createAuthDecorator() {
  return async (request: any, reply: any) => {
    const authHeader = request.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ statusMessage: 'Missing token', code: 'UNAUTHORIZED' })
    }

    request.user = { sub: 'user-1' }
    request.identity = {
      id: 'user-1',
      plan: { id: 'plan-1', name: 'Pro', isFree: false },
      permissions: {
        canWrite: true,
        leadCaptureEnabled: true,
        brandingCustomizationEnabled: true,
        embedsEnabled: true,
        qrDownloadEnabled: true,
        advancedAnalyticsEnabled: true,
      },
    }
  }
}

test('auth failure returns 401 on protected upload route', async () => {
  const app = Fastify()
  app.decorate('authenticate', createAuthDecorator())
  app.decorate('supabase', {
    from: () => ({ select: () => ({}) }),
    rpc: async () => ({ data: null, error: null }),
  } as any)
  app.decorate('s3', {} as any)

  await app.register(uploadsRoutes)

  const response = await app.inject({
    method: 'POST',
    url: '/create-signed-url',
    payload: {
      spaceId: '11111111-1111-4111-8111-111111111111',
      mediaType: 'panorama',
      fileName: 'pano.jpg',
      contentType: 'image/jpeg',
      fileSize: 2048,
    },
  })

  assert.equal(response.statusCode, 401)
  await app.close()
})

test('invalid payload is rejected for create space', async () => {
  const app = Fastify()
  app.decorate('authenticate', createAuthDecorator())
  app.decorate('supabase', {
    from: () => ({ select: () => ({}) }),
    rpc: async () => ({ data: null, error: null }),
  } as any)
  app.decorate('s3', {} as any)

  await app.register(spacesRoutes)

  const response = await app.inject({
    method: 'POST',
    url: '/',
    headers: { authorization: 'Bearer token' },
    payload: {
      title: '',
      space_type: 'invalid',
    },
  })

  assert.equal(response.statusCode, 400)
  const json = response.json()
  assert.equal(json.code, 'VALIDATION_ERROR')
  await app.close()
})

test('upload complete is idempotent for same object key', async () => {
  const state = {
    existingMedia: {
      id: 'media-1',
      property_id: VALID_SPACE_ID,
      storage_key: `users/user-1/spaces/${VALID_SPACE_ID}/panorama/same-key.jpg`,
      processing_status: 'complete',
    } as any,
    insertedMedia: null as any,
  }

  const supabase = {
    from(table: string) {
      if (table === 'properties') {
        return {
          select() {
            return this
          },
          eq() {
            return this
          },
          single: async () => ({ data: { id: '11111111-1111-4111-8111-111111111111' }, error: null }),
        }
      }

      if (table === 'property_media') {
        return {
          _insertPayload: null as any,
          select() {
            return this
          },
          eq(field: string, value: string) {
            if (field === 'storage_key' && value === state.existingMedia.storage_key) {
              ;(this as any)._existingHit = true
            }
            return this
          },
          maybeSingle: async function () {
            if ((this as any)._existingHit) return { data: state.existingMedia, error: null }
            return { data: null, error: null }
          },
          insert(payload: any) {
            this._insertPayload = payload
            return this
          },
          single: async function () {
            state.insertedMedia = {
              id: 'media-2',
              ...this._insertPayload,
            }
            return { data: state.insertedMedia, error: null }
          },
          update() {
            return this
          },
        }
      }

      if (table === 'usage_counters') {
        return {
          select() {
            return this
          },
          eq() {
            return this
          },
          single: async () => ({ data: { storage_used_bytes: 0 }, error: null }),
        }
      }

      return {
        select() {
          return this
        },
        eq() {
          return this
        },
        single: async () => ({ data: null, error: null }),
      }
    },
    rpc: async () => ({ data: null, error: null }),
  } as any

  const app = Fastify()
  app.decorate('authenticate', createAuthDecorator())
  app.decorate('supabase', supabase as any)
  app.decorate('s3', { send: async () => ({}) } as any)

  await app.register(uploadsRoutes)

  const response = await app.inject({
    method: 'POST',
    url: '/complete',
    headers: { authorization: 'Bearer token' },
    payload: {
      spaceId: '11111111-1111-4111-8111-111111111111',
      mediaType: 'panorama',
      objectKey: state.existingMedia.storage_key,
      publicUrl: 'https://media.example.com/pano.jpg',
      fileSize: 1000,
    },
  })

  assert.equal(response.statusCode, 200, response.body)
  const json = response.json()
  assert.equal(json.id, 'media-1')
  await app.close()
})

test('lead submit sanitizes html in text fields', async () => {
  let inserted: any = null

  const supabase = {
    from(table: string) {
      if (table === 'leads') {
        return {
          insert(payload: any) {
            inserted = payload
            return this
          },
          select() {
            return this
          },
          single: async () => ({ data: { id: 'lead-1', ...inserted }, error: null }),
        }
      }

      return {
        select() {
          return this
        },
        eq() {
          return this
        },
        order() {
          return this
        },
        single: async () => ({ data: null, error: null }),
      }
    },
    rpc: async () => ({ data: null, error: null }),
  } as any

  const app = Fastify()
  app.decorate('authenticate', createAuthDecorator())
  app.decorate('supabase', supabase as any)

  await app.register(leadsRoutes)

  const response = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      spaceId: '11111111-1111-4111-8111-111111111111',
      name: '<b>Jane Doe</b>',
      email: 'JANE@MAIL.COM',
      phone: '+254 700 000 000',
      message: '<p>Hello <i>there</i></p>',
      source: 'direct',
    },
  })

  assert.equal(response.statusCode, 201, response.body)
  assert.equal(inserted.name, 'Jane Doe')
  assert.equal(inserted.email, 'jane@mail.com')
  assert.equal(inserted.message, 'Hello there')
  await app.close()
})
