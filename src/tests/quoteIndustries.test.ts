// The five industries added in Phase 4c, priced from the v1 rate table.
// Each expected figure is worked out from the rate items named beside it.
import test from 'node:test'
import assert from 'node:assert/strict'

import { price } from '../quote/engine/price.js'
import { modules, validateModule } from '../quote/modules/index.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import type { Answers, PriceResult } from '../quote/engine/types.js'

const nairobi = { town: 'Nairobi' }
const run = (module: string, details: Answers['details'], extra: Partial<Answers> = {}) =>
  price(modules[module], { clientType: 'owner', details, location: nairobi, ...extra }, rateTableV1)
const totals = (r: PriceResult) => Object.fromEntries(r.options.map(o => [o.tier, o.total]))
const range = (r: PriceResult) => [r.options[0]?.total, r.options[0]?.totalHigh]

// Premium adds video 8,000 + reel 8,000 + 20 photos 4,000 (the low end the table charges)
const PREMIUM = 20_000

const fixed: Array<{ name: string; module: string; details: Answers['details']; standard: number }> = [
  { name: 'café', module: 'restaurants', details: { kind: 'cafe' }, standard: 7_000 },
  // restaurant 10,000 + night uplift 20% (2,000)
  { name: 'restaurant shot after closing', module: 'restaurants', details: { kind: 'restaurant', shoot_time: 'night' }, standard: 12_000 },
  { name: 'event venue for 300+', module: 'restaurants', details: { kind: 'venue', guests: '300plus' }, standard: 40_000 },
  { name: 'show unit + amenities', module: 'developers', details: { kind: 'show_unit_plus' }, standard: 35_000 },
  { name: 'hostel with 40 rooms', module: 'developers', details: { kind: 'hostel', hostel_rooms: '60' }, standard: 25_000 },
  { name: '1-5 acres of land', module: 'developers', details: { kind: 'land', land_size: '5_acres' }, standard: 12_000 },
  // arcade 35,000 + 10 tenant shops × 4,000
  { name: 'neighbourhood centre with 10 shops', module: 'malls', details: { kind: 'mall', mall_size: 'arcade', tenants: 10 }, standard: 75_000 },
  { name: 'boutique', module: 'malls', details: { kind: 'shop' }, standard: 7_000 },
  { name: 'office up to 20 desks', module: 'institutions', details: { kind: 'office', desks: '20' }, standard: 10_000 },
  { name: 'large secondary school', module: 'institutions', details: { kind: 'school', school_size: 'large' }, standard: 35_000 },
  { name: 'vet clinic', module: 'institutions', details: { kind: 'vet' }, standard: 10_000 },
  { name: 'greenhouse farm', module: 'farms', details: { kind: 'farm' }, standard: 15_000 },
  { name: 'warehouse up to 50,000 sq ft', module: 'farms', details: { kind: 'warehouse', warehouse_size: '50k' }, standard: 30_000 },
]

for (const ex of fixed) {
  test(`industries: ${ex.name} is an instant price`, () => {
    const r = run(ex.module, ex.details)
    assert.equal(r.mode, 'instant')
    assert.deepEqual(totals(r), { essential: ex.standard, standard: ex.standard, premium: ex.standard + PREMIUM })
    for (const o of r.options) {
      assert.equal(o.net, o.lines.reduce((s, l) => s + l.amount, 0))
      assert.equal(o.deposit, Math.round(o.total / 2))
    }
  })
}

test('industries: land has no minimum job price, so a plot is the rate card price', () => {
  const o = run('developers', { kind: 'land', land_size: 'plot' }).options[1]
  assert.equal(o.total, 3_500)
  assert.equal(o.lines.some(l => l.kind === 'minimum'), false)
  // Other developer jobs are unchanged
  assert.equal(run('developers', { kind: 'hostel', hostel_rooms: '20' }).options[1].total, 15_000)
})

test('industries: where the rate card gives a range, the visitor sees the range', () => {
  // commercial_let 6,000-12,000 per unit, 3 units
  assert.deepEqual([run('developers', { kind: 'commercial', units: 3 }).mode, ...range(run('developers', { kind: 'commercial', units: 3 }))], ['range', 18_000, 36_000])
  // dev_progress 8,000-20,000 per visit, 4 visits
  assert.deepEqual(range(run('developers', { kind: 'progress', visits: 4 })), [32_000, 80_000])
  assert.deepEqual(range(run('developers', { kind: 'full' })), [60_000, 150_000])
  assert.deepEqual(range(run('malls', { kind: 'mall', mall_size: 'regional' })), [150_000, 250_000])
  assert.deepEqual(range(run('institutions', { kind: 'clinic' })), [10_000, 15_000])
  assert.deepEqual(range(run('farms', { kind: 'factory' })), [40_000, 120_000])
  assert.deepEqual(range(run('restaurants', { kind: 'nightlife' })), [10_000, 20_000])
  // A range is an estimate: one option, never three tiers
  assert.deepEqual(run('farms', { kind: 'factory' }).options.map(o => o.tier), ['estimate'])
})

test('industries: "from" prices and the biggest places are confirmed by staff', () => {
  for (const [module, details] of [
    ['malls', { kind: 'popup' }],                                     // popup: from 5,000
    ['malls', { kind: 'mall', mall_size: 'super' }],                  // super-regional: custom
    ['malls', { kind: 'mall', mall_size: 'arcade', anchors: 1 }],     // anchor tenants: from 20,000
    ['developers', { kind: 'land', land_size: '50plus' }],
    ['developers', { kind: 'memorial' }],
    ['institutions', { kind: 'school', school_size: 'intl' }],
    ['institutions', { kind: 'hospital', beds: '50plus' }],
    ['institutions', { kind: 'museum' }],
    ['institutions', { kind: 'office', desks: '100plus' }],          // no rate item: staff price it
    ['farms', { kind: 'warehouse', warehouse_size: '50kplus' }],
    ['farms', { kind: 'farm_large' }],
  ] as const) {
    assert.equal(run(module, details as Answers['details']).mode, 'custom', `${module} ${JSON.stringify(details)}`)
  }
})

test('industries: follow-up questions only count when they apply', () => {
  // Tenants are a mall question; a shop with a stray tenants answer is still a shop
  assert.equal(run('malls', { kind: 'shop', tenants: 5 }).options[1].total, 7_000)
  // A venue needs its size before there is a price
  const r = run('restaurants', { kind: 'venue' })
  assert.deepEqual([r.mode, r.options.length, r.missing], ['custom', 0, ['guests']])
})

test('industries: all ten modules are enabled, and the five planned ones are real modules now', () => {
  for (const key of ['restaurants', 'developers', 'malls', 'institutions', 'farms']) {
    assert.equal(modules[key]?.enabled, true, key)
    assert.notEqual(modules[key].resultMode, 'custom', key)
  }
})

test('industries: wayfinding and floor plans always go to staff, with no price shown', () => {
  const jobs = [
    ['wayfinding', { venue: 'mall', floors: 3, destinations: 120, tour: 'yes', plans: 'cad' }],
    ['wayfinding', { venue: 'hospital', floors: 1, destinations: 10, tour: 'no', plans: 'none' }],
    ['floorplans', { place: 'home', floors: 1, floor_size: 's', deliverable: 'redraw' }],
    ['floorplans', { place: 'building', floors: 12, floor_size: 'xl', deliverable: 'measured' }],
  ] as const
  for (const [module, details] of jobs) {
    const r = run(module, details as Answers['details'], { addons: { website_embed: 1 } })
    assert.deepEqual([r.mode, r.options.length], ['custom', 0], `${module} ${JSON.stringify(details)}`)
  }
  for (const key of ['wayfinding', 'floorplans']) {
    assert.equal(modules[key].resultMode, 'custom', key)
    assert.equal(modules[key].pricing.base, undefined, `${key} has no base price yet`)
    assert.deepEqual(validateModule(modules[key], rateTableV1), [], key)
  }
})
