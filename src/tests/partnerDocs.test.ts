import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as nodeCrypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify from 'fastify'
import partnerDocsRoutes, { DOCS_CSP, SCALAR_SRC, SCALAR_SRI, SCALAR_VERSION } from '../routes/partnerDocs.js'
import { GUIDE_MARKDOWN } from '../partners/docsGuide.generated.js'
import { guideMarkdown } from '../partners/docsGuide.js'
import { signPayload } from '../partners/webhooks.js'
import { keepsOwnShape } from '../utils/ownShapeRoutes.js'

async function app(listings: boolean) {
  const f = Fastify()
  await f.register(partnerDocsRoutes, { listings })
  await f.ready()
  return f
}

test('docs page: pinned Scalar with an integrity hash and a strict CSP', async () => {
  const f = await app(true)
  const r = await f.inject({ method: 'GET', url: '/docs' })
  assert.equal(r.statusCode, 200)
  assert.match(r.headers['content-type'] as string, /text\/html/)
  assert.equal(r.headers['content-security-policy'], DOCS_CSP)
  assert.match(DOCS_CSP, /connect-src 'self'(;|$)/, 'a key typed into Try it only goes to this server')
  assert.match(DOCS_CSP, /frame-ancestors 'none'/)
  assert.ok(r.body.includes(`src="${SCALAR_SRC}" integrity="${SCALAR_SRI}"`))
  assert.match(SCALAR_VERSION, /^\d+\.\d+\.\d+$/, 'exact version, never a range')
  assert.ok(!/<script>(?!<\/script>)/.test(r.body), 'no inline script')
})

test('docs config switches off telemetry, the AI agent and MCP, and tries requests against this host', async () => {
  const f = await app(true)
  const js = (await f.inject({ method: 'GET', url: '/docs/init.js' })).body
  for (const s of ['telemetry: false', "agent: { disabled: true }", 'mcp: { disabled: true }', 'persistAuth: false', "location.origin + '/v1'", 'withDefaultFonts: false']) {
    assert.ok(js.includes(s), s)
  }
  assert.ok(!js.includes('proxyUrl'), 'no request proxy')
})

test('reference covers agents, tours and uploads always, and listings only when switched on', async () => {
  const on = (await (await app(true)).inject({ method: 'GET', url: '/docs/openapi.json' })).json()
  for (const p of ['/agents', '/agents/{external_id}', '/tours', '/tours/{id}', '/tours/{id}/publish', '/tours/{id}/uploads', '/tours/{id}/uploads/complete', '/listings', '/webhooks', '/claims', '/leads']) assert.ok(on.paths[p], p)
  assert.ok(on.webhooks?.event)
  assert.ok(on.components.schemas.TourInput.properties.agent_external_id)
  for (const [path, methods] of Object.entries<any>(on.paths)) {
    for (const [m, o] of Object.entries<any>(methods)) {
      assert.ok(o.tags?.length === 1 && o.tags[0] !== 'Other', `${m} ${path} has a tag`)
      assert.match(o.description, /Scope: `[a-z]+:[a-z]+`/, `${m} ${path} names its scope`)
    }
  }
  assert.deepEqual(on['x-tagGroups'][0].tags, on.tags.map((t: any) => t.name))

  const off = (await (await app(false)).inject({ method: 'GET', url: '/docs/openapi.json' })).json()
  assert.ok(off.paths['/tours'] && !off.paths['/listings'] && !off.paths['/webhooks'])
  assert.equal(off.webhooks, undefined)
  assert.ok(!off.info.description.includes('# Receiving events'))
  assert.ok(off.info.description.includes('Create a tour, upload photos and publish'))
  assert.ok(!on.info.description.includes('Create a tour, upload photos and publish'))
  for (const d of [on.info.description, off.info.description]) assert.ok(!d.includes('<!--'), 'markers removed')
})

test('Postman collection downloads as a file', async () => {
  const r = await (await app(true)).inject({ method: 'GET', url: '/docs/postman.json' })
  assert.equal(r.statusCode, 200)
  assert.match(r.headers['content-disposition'] as string, /attachment/)
  assert.ok(r.json().item.length >= 25)
})

test('/docs keeps its own JSON shape (no global envelope)', () => {
  for (const u of ['/docs', '/docs/openapi.json', '/docs/postman.json']) assert.equal(keepsOwnShape(u), true, u)
  assert.equal(keepsOwnShape('/docsx'), false)
})

test('generated guide matches docs/developers/guide.md (run npm run partner:openapi after editing it)', () => {
  const md = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'developers', 'guide.md'), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(GUIDE_MARKDOWN, md)
})

test('a table row behind a marker is kept when listings are on', () => {
  const src = '| a |\n|---|\n<!-- listings -->| b |\n<!-- /listings -->\nend'
  assert.equal(guideMarkdown(true, src), '| a |\n|---|\n| b |\nend')
  assert.equal(guideMarkdown(false, src), '| a |\n|---|\nend')
})

test('the Node.js signature check printed in the guide accepts real Viewora signatures, including during a rotation', () => {
  const block = GUIDE_MARKDOWN.match(/```js\n([\s\S]*?)```/)![1]
  const code = block.replace("import crypto from 'node:crypto'", '').replace('export function', 'function') + '\nreturn verifyViewora'
  // eslint-disable-next-line no-new-func
  const verify = new Function('crypto', code)(nodeCrypto) as (s: string, b: string, h: string) => boolean
  const body = JSON.stringify({ id: 'evt_1', type: 'listing.published' })
  const now = Math.floor(Date.now() / 1000)
  assert.equal(verify('whsec_new', body, signPayload('whsec_new', body, now)), true)
  assert.equal(verify('whsec_old', body, signPayload('whsec_new', body, now, ['whsec_old'])), true, 'old secret still works during rotation')
  assert.equal(verify('whsec_new', body, signPayload('whsec_new', body, now, ['whsec_old'])), true)
  assert.equal(verify('whsec_other', body, signPayload('whsec_new', body, now)), false)
  assert.equal(verify('whsec_new', body + ' ', signPayload('whsec_new', body, now)), false, 'changed body')
  assert.equal(verify('whsec_new', body, signPayload('whsec_new', body, now - 600)), false, 'too old')
})
