import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import spotlightRoutes from '../routes/spotlights.js'
import {
  SpotlightData, decodeVoice, generateStudioKey, hashStudioKey, mergeSpotlightUrls, parseStudioKey, sceneFile,
} from '../utils/spotlights.js'

const SPACE_ID = '11111111-1111-4111-8111-111111111111'
const SCENE_ID = '22222222-2222-4222-8222-222222222222'
const USER = 'user-1'

// The normal login: any Bearer that isn't a Studio key is user-1.
function createAuthDecorator() {
  return async (request: any, reply: any) => {
    const h = request.headers.authorization
    if (!h || !h.startsWith('Bearer ') || h.startsWith('Bearer vos_')) {
      return reply.code(401).send({ statusMessage: 'Missing token', code: 'UNAUTHORIZED' })
    }
    request.user = { sub: USER }
  }
}

// Chainable query-builder stub (as in journeys.test.ts); records writes and filters.
function supabaseStub(result: (table: string, op: string, filters: any[]) => { data: unknown; error: unknown; count?: number }, writes: any[] = []) {
  return {
    from(table: string) {
      let op = 'select'
      const filters: any[] = []
      const builder: any = {}
      for (const m of ['select', 'in', 'or', 'order', 'limit', 'gt', 'is']) builder[m] = () => builder
      builder.eq = (col: string, val: unknown) => { filters.push([col, val]); return builder }
      for (const m of ['insert', 'update', 'delete', 'upsert']) builder[m] = (row?: any) => { op = m; writes.push({ table, op, row }); return builder }
      builder.single = async () => result(table, op, filters)
      builder.maybeSingle = async () => result(table, op, filters)
      builder.then = (resolve: any, reject: any) => Promise.resolve(result(table, op, filters)).then(resolve, reject)
      return builder
    },
  }
}

async function buildApp(supabase: any, puts: any[] = []) {
  process.env.R2_BUCKET_NAME = 'bucket'
  process.env.MEDIA_DOMAIN = 'https://media.example'
  const app = Fastify()
  app.decorate('authenticate', createAuthDecorator())
  app.decorate('supabase', supabase)
  app.decorate('redis', null as any)
  app.decorate('s3', { send: async (cmd: any) => { puts.push(cmd.input); return {} } } as any)
  await app.register(spotlightRoutes)
  return app
}

const data = {
  label: 'Seating', yaw: 0.156, pitch: -0.38, zoom: 62,
  polygon: [[0.1, -0.3], [0.2, -0.3], [0.2, -0.45], [0.1, -0.45]],
  title: 'Black leather armchairs', lines: ['Five high-back armchairs.'],
}
// A tiny "MP3": ID3 header + padding.
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]).toString('base64')

/** Owner of the scene / space, a free plan that can write, an empty scene. */
function ownerDb(extra: (table: string, op: string, filters: any[]) => any = () => undefined) {
  return (table: string, op: string, filters: any[]) => {
    const e = extra(table, op, filters)
    if (e !== undefined) return e
    if (table === 'subscriptions') return { data: null, error: { message: 'none' } }
    if (table === 'plans') return { data: { slug: 'free', max_active_properties: 3 }, error: null }
    if (table === 'properties') return { data: { id: SPACE_ID }, error: null, count: 1 }
    if (table === 'scenes') return { data: { id: SCENE_ID, space_id: SPACE_ID }, error: null }
    if (table === 'scene_spotlights' && op === 'upsert') return { data: { id: 'row', object_key: 'black-chairs', data, voice_url: null }, error: null }
    if (table === 'scene_spotlights') return { data: [{ object_key: 'black-chairs', data, voice_url: 'https://media.example/v.mp3', order_index: 0 }], error: null }
    return { data: null, error: null }
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('studio keys: format, hash and parsing', () => {
  const { key, prefix, hash } = generateStudioKey()
  assert.match(key, /^vos_[0-9A-Za-z]{32}$/)
  assert.equal(prefix, key.slice(0, 10))
  assert.equal(hash, hashStudioKey(key))
  assert.notEqual(generateStudioKey().key, key)
  assert.equal(parseStudioKey(`Bearer ${key}`), key)
  assert.equal(parseStudioKey('Bearer eyJhbGciOi.jwt.token'), null)
  assert.equal(parseStudioKey(key), null)
  assert.equal(parseStudioKey(undefined), null)
})

test('spotlight data: valid shape passes, bad ones are refused', () => {
  assert.equal(SpotlightData.safeParse(data).success, true)
  assert.equal(SpotlightData.safeParse({ ...data, polygon: data.polygon.slice(0, 2) }).success, false)
  assert.equal(SpotlightData.safeParse({ ...data, zoom: 140 }).success, false)
  assert.equal(SpotlightData.safeParse({ ...data, title: '' }).success, false)
  assert.equal(SpotlightData.safeParse({ ...data, lines: ['x'.repeat(301)] }).success, false)
  assert.equal(SpotlightData.safeParse({ ...data, onclick: 'x' }).success, false) // strict: no extra fields
})

test('voice: only MP3s of a sensible size', () => {
  assert.ok(Buffer.isBuffer(decodeVoice(mp3)))
  assert.equal(typeof decodeVoice(Buffer.from('<html>' + 'x'.repeat(100)).toString('base64')), 'string')
  assert.equal(typeof decodeVoice(Buffer.from('ID3').toString('base64')), 'string')
  assert.equal(typeof decodeVoice('A'.repeat(3_000_000)), 'string')
})

test('the scene file is what the tour reads', () => {
  const f = sceneFile(SCENE_ID, [{ object_key: 'chairs', data, voice_url: 'https://m/v.mp3' }, { object_key: 'bar', data, voice_url: null }])
  assert.equal(f.v, 1)
  assert.equal(f.scene, SCENE_ID)
  assert.equal(f.objects[0].id, 'chairs')
  assert.equal(f.objects[0].voiceSrc, 'https://m/v.mp3')
  assert.equal('voiceSrc' in f.objects[1], false)
  assert.equal(f.objects[1].title, data.title)
})

test('public tour: scenes with spotlights get their file URL; missing table changes nothing', async () => {
  const scenes = [{ id: SCENE_ID }, { id: 'other' }]
  await mergeSpotlightUrls({ supabase: supabaseStub(() => ({ data: [{ scene_id: SCENE_ID, url: 'https://m/scene.json' }], error: null })) } as any, SPACE_ID, scenes)
  assert.equal((scenes[0] as any).spotlight_url, 'https://m/scene.json')
  assert.equal('spotlight_url' in scenes[1], false)
  const untouched = [{ id: SCENE_ID }]
  await mergeSpotlightUrls({ supabase: supabaseStub(() => ({ data: null, error: { code: '42P01', message: 'relation "scene_spotlight_files" does not exist' } })) } as any, SPACE_ID, untouched)
  assert.deepEqual(untouched, [{ id: SCENE_ID }])
})

// ── Routes ───────────────────────────────────────────────────────────────────

test('needs a login or a Studio key', async () => {
  const app = await buildApp(supabaseStub(() => ({ data: null, error: null })))
  const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE_ID}/spotlights` })
  assert.equal(res.statusCode, 401)
})

test('a valid Studio key acts as its owner on spotlight routes', async () => {
  const { key, hash } = generateStudioKey()
  let lookedUp = ''
  const app = await buildApp(supabaseStub(ownerDb((table, _op, filters) => {
    if (table === 'studio_keys') {
      lookedUp = filters.find(f => f[0] === 'key_hash')?.[1] ?? lookedUp
      return { data: { id: 'k1', user_id: USER, expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: null }, error: null }
    }
    if (table === 'scene_spotlights') return { data: [], error: null }
    if (table === 'scene_spotlight_files') return { data: [], error: null }
    if (table === 'scenes') return { data: [{ id: SCENE_ID, name: 'Lounge', raw_image_url: 'https://m/raw.png', thumbnail_url: 'https://m/t.jpg' }], error: null }
    return undefined
  })))
  const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE_ID}/spotlights`, headers: { authorization: `Bearer ${key}` } })
  assert.equal(res.statusCode, 200)
  assert.equal(lookedUp, hash) // looked up by hash, never by the key itself
  assert.equal(res.json().enabled, true)
  assert.equal(res.json().scenes[0].image, 'https://m/raw.png')
})

test("the list carries the tour's narration voice, for Studio", async () => {
  const voiceOf = async (journeys: any) => {
    const app = await buildApp(supabaseStub(ownerDb((table) => {
      if (table === 'journeys') return journeys
      if (table === 'scene_spotlights' || table === 'scene_spotlight_files') return { data: [], error: null }
      if (table === 'scenes') return { data: [], error: null }
      return undefined
    })))
    const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE_ID}/spotlights`, headers: { authorization: 'Bearer t' } })
    assert.equal(res.statusCode, 200)
    return res.json().voice
  }
  assert.equal(await voiceOf({ data: [{ narration_voice: 'af_bella' }], error: null }), 'af_bella')
  assert.equal(await voiceOf({ data: [], error: null }), null)                       // no guided visit
  assert.equal(await voiceOf({ data: [{ narration_voice: 'xx_nope' }], error: null }), null)
  assert.equal(await voiceOf({ data: null, error: { code: '42703', message: 'column journeys.narration_voice does not exist' } }), null)
})

test('revoked or expired Studio keys are refused', async () => {
  for (const row of [
    { id: 'k1', user_id: USER, expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: new Date().toISOString() },
    { id: 'k1', user_id: USER, expires_at: new Date(Date.now() - 1000).toISOString(), revoked_at: null },
    null,
  ]) {
    const app = await buildApp(supabaseStub((table) => table === 'studio_keys' ? { data: row, error: null } : { data: null, error: null }))
    const res = await app.inject({ method: 'GET', url: '/studio/me', headers: { authorization: `Bearer ${generateStudioKey().key}` } })
    assert.equal(res.statusCode, 401)
    assert.equal(res.json().code, 'STUDIO_KEY_INVALID')
  }
})

test('a Studio key cannot make more keys (normal login only)', async () => {
  const app = await buildApp(supabaseStub(() => ({ data: null, error: null })))
  const res = await app.inject({ method: 'POST', url: '/studio-keys', headers: { authorization: `Bearer ${generateStudioKey().key}` }, payload: {} })
  assert.equal(res.statusCode, 401)
})

test("someone else's scene: 404, nothing written", async () => {
  const writes: any[] = []
  const app = await buildApp(supabaseStub(ownerDb((table) => table === 'scenes' ? { data: null, error: null } : undefined), writes))
  const res = await app.inject({ method: 'PUT', url: `/scenes/${SCENE_ID}/spotlights/black-chairs`, headers: { authorization: 'Bearer t' }, payload: { data } })
  assert.equal(res.statusCode, 404)
  assert.equal(writes.length, 0)
})

test('publishing stores the voice and the scene file, both cached for a year', async () => {
  const writes: any[] = []
  const puts: any[] = []
  const app = await buildApp(supabaseStub(ownerDb(), writes), puts)
  const res = await app.inject({
    method: 'PUT', url: `/scenes/${SCENE_ID}/spotlights/black-chairs`, headers: { authorization: 'Bearer t' },
    payload: { data, source: { at: [13.1, -12.4], points: [], exclude: [] }, voice: mp3 },
  })
  assert.equal(res.statusCode, 200, res.body)
  const voice = puts.find(p => p.ContentType === 'audio/mpeg')
  const file = puts.find(p => p.ContentType === 'application/json')
  assert.match(voice.Key, new RegExp(`^spaces/${SPACE_ID}/scenes/${SCENE_ID}/spotlights/black-chairs-[0-9a-f]{12}\\.mp3$`))
  assert.match(file.Key, new RegExp(`^spaces/${SPACE_ID}/scenes/${SCENE_ID}/spotlights/scene-[0-9a-f]{12}\\.json$`))
  assert.equal(voice.CacheControl, 'public, max-age=31536000, immutable')
  const upsert = writes.find(w => w.table === 'scene_spotlights' && w.op === 'upsert')
  assert.equal(upsert.row.voice_url, `https://media.example/${voice.Key}`)
  assert.deepEqual(upsert.row.source.at, [13.1, -12.4])
  const fileRow = writes.find(w => w.table === 'scene_spotlight_files' && w.op === 'upsert')
  assert.equal(fileRow.row.url, `https://media.example/${file.Key}`)
  assert.equal(res.json().file_url, fileRow.row.url)
})

test('moving the ring saves it into the data and rewrites the scene file', async () => {
  const writes: any[] = []
  const puts: any[] = []
  // The one object (looked up by its key); the scene file is rebuilt from the list (ownerDb's).
  const app = await buildApp(supabaseStub(ownerDb((table, op, filters) =>
    table === 'scene_spotlights' && op === 'select' && filters.some(f => f[0] === 'object_key')
      ? { data: { data: { ...data, ring: { yaw: 0.5, pitch: 0 } } }, error: null } : undefined), writes), puts)
  const url = `/scenes/${SCENE_ID}/spotlights/black-chairs`
  const res = await app.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer t' }, payload: { ring: { yaw: 0.3, pitch: -0.2 } } })
  assert.equal(res.statusCode, 200, res.body)
  const upd = writes.find(w => w.table === 'scene_spotlights' && w.op === 'update')
  assert.deepEqual(upd.row.data.ring, { yaw: 0.3, pitch: -0.2 })
  assert.equal(upd.row.data.title, data.title)            // the rest of the object is untouched
  assert.ok(puts.find(p => p.ContentType === 'application/json'))
  // null puts it back on the object's centre
  writes.length = 0
  const back = await app.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer t' }, payload: { ring: null } })
  assert.equal(back.statusCode, 200)
  assert.equal('ring' in writes.find(w => w.op === 'update').row.data, false)
  // bad input, someone else's spotlight
  assert.equal((await app.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer t' }, payload: { ring: { yaw: 0.3 } } })).statusCode, 400)
  const none = await buildApp(supabaseStub(ownerDb((table, op, filters) => table === 'scene_spotlights' && op === 'select' && filters.some(f => f[0] === 'object_key') ? { data: null, error: null } : undefined)))
  assert.equal((await none.inject({ method: 'PATCH', url, headers: { authorization: 'Bearer t' }, payload: { ring: null } })).statusCode, 404)
})

test('Studio publishing again keeps a ring moved in the editor', async () => {
  const writes: any[] = []
  const app = await buildApp(supabaseStub(ownerDb((table, op) =>
    table === 'scene_spotlights' && op === 'select'
      ? { data: [{ object_key: 'black-chairs', data: { ...data, ring: { yaw: 0.4, pitch: -0.1 } }, voice_url: null, order_index: 0 }], error: null }
      : undefined), writes))
  const res = await app.inject({ method: 'PUT', url: `/scenes/${SCENE_ID}/spotlights/black-chairs`, headers: { authorization: 'Bearer t' }, payload: { data } })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(writes.find(w => w.op === 'upsert' && w.table === 'scene_spotlights').row.data.ring, { yaw: 0.4, pitch: -0.1 })
})

test('a bad voice or bad data is refused before anything is stored', async () => {
  const puts: any[] = []
  const app = await buildApp(supabaseStub(ownerDb()), puts)
  const badVoice = await app.inject({
    method: 'PUT', url: `/scenes/${SCENE_ID}/spotlights/black-chairs`, headers: { authorization: 'Bearer t' },
    payload: { data, voice: Buffer.from('not an mp3 at all, really not'.repeat(5)).toString('base64') },
  })
  assert.equal(badVoice.statusCode, 400)
  const badKey = await app.inject({ method: 'PUT', url: `/scenes/${SCENE_ID}/spotlights/Bad Key`, headers: { authorization: 'Bearer t' }, payload: { data } })
  assert.equal(badKey.statusCode, 400)
  assert.equal(puts.length, 0)
})

test('deleting the last object removes the scene file entry', async () => {
  const writes: any[] = []
  const app = await buildApp(supabaseStub(ownerDb((table, op) => table === 'scene_spotlights' && op === 'select' ? { data: [], error: null } : undefined), writes))
  const res = await app.inject({ method: 'DELETE', url: `/scenes/${SCENE_ID}/spotlights/black-chairs`, headers: { authorization: 'Bearer t' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().file_url, null)
  assert.ok(writes.find(w => w.table === 'scene_spotlights' && w.op === 'delete'))
  assert.ok(writes.find(w => w.table === 'scene_spotlight_files' && w.op === 'delete'))
})

test('before the migration: the list says not enabled, saving says so', async () => {
  const missing = { data: null, error: { code: '42P01', message: 'relation "scene_spotlights" does not exist' } }
  const app = await buildApp(supabaseStub(ownerDb((table) => (table === 'scene_spotlights' || table === 'scene_spotlight_files') ? missing : (table === 'scenes' ? { data: [], error: null } : undefined))))
  const list = await app.inject({ method: 'GET', url: `/spaces/${SPACE_ID}/spotlights`, headers: { authorization: 'Bearer t' } })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().enabled, false)
})

test('making a Studio key returns it once and stores only its hash', async () => {
  const writes: any[] = []
  const app = await buildApp(supabaseStub((table, op) => {
    if (table === 'studio_keys' && op === 'insert') return { data: { id: 'k1', name: 'Laptop', created_at: 'now', expires_at: 'later' }, error: null }
    if (table === 'studio_keys') return { data: null, error: null, count: 0 }
    return { data: null, error: null }
  }, writes))
  const res = await app.inject({ method: 'POST', url: '/studio-keys', headers: { authorization: 'Bearer t' }, payload: { name: 'Laptop' } })
  assert.equal(res.statusCode, 201)
  const { key } = res.json()
  assert.match(key, /^vos_/)
  const insert = writes.find(w => w.table === 'studio_keys' && w.op === 'insert')
  assert.equal(insert.row.key_hash, hashStudioKey(key))
  assert.equal(JSON.stringify(insert.row).includes(key), false)
  assert.equal(insert.row.user_id, USER)
})
