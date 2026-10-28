// Quotes in US dollars (Phase 5c): converted from the rate card at the rate
// table's usdKesRate, in cents, so every total still adds up.
import test from 'node:test'
import assert from 'node:assert/strict'

import { price } from '../quote/engine/price.js'
import { modules } from '../quote/modules/index.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import { payBlocker } from '../quote/jobs.js'
import type { Answers } from '../quote/engine/types.js'

const run = (module: string, details: Answers['details'], currency: 'KES' | 'USD') =>
  price(modules[module], { clientType: 'owner', details, location: { town: 'Nairobi' } }, rateTableV1, { currency })
const RATE = rateTableV1.settings.usdKesRate
const cents = (kes: number) => Math.round((kes * 100) / RATE)

test('usd: a fixed price converts to cents, and the lines still add up', () => {
  const kes = run('restaurants', { kind: 'cafe' }, 'KES')
  const usd = run('restaurants', { kind: 'cafe' }, 'USD')
  assert.deepEqual([usd.mode, usd.currency, usd.fxRate], ['instant', 'USD', RATE])
  const [k, u] = [kes.options[1], usd.options[1]]
  assert.equal(u.total, cents(k.total))
  for (const o of usd.options) {
    assert.equal(Number.isInteger(o.total) && Number.isInteger(o.deposit), true)
    assert.equal(o.net, o.lines.reduce((s, l) => s + l.amount, 0))
  }
})

test('usd: a rate card range converts both ends', () => {
  const kes = run('farms', { kind: 'factory' }, 'KES').options[0]
  const usd = run('farms', { kind: 'factory' }, 'USD').options[0]
  assert.equal(usd.total, cents(kes.total))
  assert.equal(usd.totalHigh, cents(kes.totalHigh!))
})

test('usd: no card payment until Paystack USD is confirmed; the client is sent a link', () => {
  const doc = { status: 'sent', mode: 'instant', currency: 'USD', options: [{ deposit: 2_700, lines: [] }] } as any
  assert.equal(payBlocker(doc, 'open', { hasJob: false, paymentsOn: true }), 'usd_by_link')
  assert.equal(payBlocker(doc, 'open', { hasJob: false, paymentsOn: true, usdPayments: true }), null)
  assert.equal(payBlocker({ ...doc, currency: 'KES' }, 'open', { hasJob: false, paymentsOn: true }), null)
})
