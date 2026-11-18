import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepsOwnShape, unwrapEnvelope } from '../utils/ownShapeRoutes.js'

test('partner API, embed policy and quote routes skip the global envelope', () => {
  for (const u of ['/v1/tours', '/v1/tours?external_id=X', '/v1', '/embed-policy/nice-house', '/quote/x', '/admin/quote/rates']) {
    assert.equal(keepsOwnShape(u), true, u)
  }
  for (const u of ['/spaces', '/v10/x', '/v1x', '/admin/partners', '/p/nice-house', '/embed-policyx']) {
    assert.equal(keepsOwnShape(u), false, u)
  }
})

test('unwrapEnvelope returns data from a success envelope and leaves errors alone', () => {
  assert.deepEqual(unwrapEnvelope({ success: true, data: { id: 'a' }, meta: {} }), { id: 'a' })
  const err = { success: false, code: 'NOT_FOUND', message: 'Space not found' }
  assert.equal(unwrapEnvelope(err), err)
  assert.deepEqual(unwrapEnvelope({ id: 'b' }), { id: 'b' })
  assert.equal(unwrapEnvelope(null), null)
})
