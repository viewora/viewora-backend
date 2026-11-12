import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import profileRoutes from '../routes/profile.js'

// Records what the route writes to `profiles` and echoes it back.
function profilesStub() {
  const writes: any[] = []
  const selects: string[] = []
  const sb = {
    from() {
      let payload: any = null
      const b: any = {}
      b.select = (cols: string) => { selects.push(cols); return b }
      b.update = (p: any) => { payload = p; writes.push(p); return b }
      b.eq = () => b
      b.single = async () => ({ data: { id: 'user-1', full_name: 'Jane', company_name: 'Demo Motors', ...(payload ?? {}) }, error: null })
      return b
    },
  }
  return { sb, writes, selects }
}

async function buildApp(supabase: any) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = { sub: 'user-1' } })
  app.decorate('supabase', supabase)
  await app.register(profileRoutes)
  return app
}

test('profile: the business name is read and saved, trimmed', async () => {
  const { sb, writes, selects } = profilesStub()
  const app = await buildApp(sb)
  const got = await app.inject({ method: 'GET', url: '/' })
  assert.equal(got.json().company_name, 'Demo Motors')
  assert.ok(selects[0].includes('company_name'))
  const res = await app.inject({ method: 'PATCH', url: '/', payload: { company_name: '  Simba Motors  ' } })
  assert.equal(res.statusCode, 200)
  assert.equal(writes[0].company_name, 'Simba Motors')
  assert.equal(res.json().company_name, 'Simba Motors')
})

test('profile: an empty business name clears it; an overlong one is refused', async () => {
  const { sb, writes } = profilesStub()
  const app = await buildApp(sb)
  await app.inject({ method: 'PATCH', url: '/', payload: { company_name: '   ' } })
  assert.equal(writes[0].company_name, null)
  const res = await app.inject({ method: 'PATCH', url: '/', payload: { company_name: 'x'.repeat(121) } })
  assert.equal(res.statusCode, 400)
})
