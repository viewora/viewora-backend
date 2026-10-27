import test from 'node:test'
import assert from 'node:assert/strict'

import { price } from '../quote/engine/price.js'
import { normalisePhone } from '../quote/engine/phone.js'
import { resolveZone } from '../quote/engine/zones.js'
import { modules, validateModule } from '../quote/modules/index.js'
import { rateTableV1 } from '../quote/seed/rateTable.v1.js'
import type { Answers, PriceResult, RateTable } from '../quote/engine/types.js'

const nairobi = { town: 'Nairobi' }
const totals = (r: PriceResult) => Object.fromEntries(r.options.map(o => [o.tier, o.total]))

// ── Examples from the rate card ─────────────────────────────────────────────

const examples: Array<{ name: string; module: string; answers: Answers; expect: Record<string, number> }> = [
  {
    name: 'studio, owner, Nairobi',
    module: 'homes',
    answers: { clientType: 'owner', details: { size: 'studio', purpose: 'let' }, location: nairobi },
    expect: { essential: 4500, standard: 4500, premium: 24500 },
  },
  {
    name: '3-bedroom for sale with a video',
    module: 'homes',
    answers: { clientType: 'owner', details: { size: '3br', purpose: 'sale' }, addons: { video: 1 }, location: nairobi },
    // 9,000 + 30% sale uplift (2,700) = 11,700; + video 8,000 = 19,700; premium adds reel 8,000 + photos 4,000
    expect: { essential: 11700, standard: 19700, premium: 31700 },
  },
  {
    name: '40-room hotel',
    module: 'hotels',
    answers: { clientType: 'manager', details: { kind: 'hotel', rooms_hotel: '50' }, location: nairobi },
    expect: { essential: 50000, standard: 50000, premium: 70000 },
  },
  {
    name: '20-vehicle showroom',
    module: 'vehicles',
    answers: { clientType: 'owner', details: { kind: 'showroom', showroom_size: '30', vehicles: 20 }, location: nairobi },
    // showroom up to 30 vehicles 18,000 + 20 interior spins at the 10+ rate of 1,000
    expect: { essential: 38000, standard: 38000, premium: 58000 },
  },
  {
    name: '10-property agent pack',
    module: 'homes',
    answers: { clientType: 'agent', details: { size: '2br', purpose: 'let', listings: 10 }, location: nairobi },
    // 10 × 7,000 = 70,000, less 15% pack discount (10,500)
    expect: { essential: 59500, standard: 59500, premium: 79500 },
  },
]

for (const ex of examples) {
  test(`price: ${ex.name}`, () => {
    const r = price(modules[ex.module], ex.answers, rateTableV1)
    assert.equal(r.mode, 'instant')
    assert.deepEqual(totals(r), ex.expect)
    for (const o of r.options) {
      assert.equal(o.net, o.lines.reduce((s, l) => s + l.amount, 0), 'lines add up to net')
      assert.equal(o.deposit, Math.round(o.total / 2), '50% deposit')
      assert.ok(Number.isInteger(o.total), 'money is an integer')
    }
  })
}

test('price: agent pack shows the discount as its own line', () => {
  const r = price(modules.homes, examples[4].answers, rateTableV1)
  const essential = r.options[0]
  assert.equal(essential.subtotal, 70000)
  assert.equal(essential.discount, 10500)
  assert.equal(essential.discountBp, 1500)
  assert.ok(essential.lines.some(l => l.key === 'pack_10' && l.amount === -10500))
})

test('price: travel is always a separate line', () => {
  const r = price(modules.homes, { ...examples[0].answers, location: { town: 'Kitengela' } }, rateTableV1)
  const line = r.options[0].lines.find(l => l.kind === 'travel')
  assert.equal(line?.key, 'travel_greater')
  assert.equal(r.options[0].total, 6500)
  assert.equal(r.travelZone, 'travel_greater')
})

// ── Plan check ──────────────────────────────────────────────────────────────

test('plan check: warns when the tour has more scenes than the plan allows', () => {
  const r = price(modules.hotels, examples[2].answers, rateTableV1, { plan: 'creator' })
  assert.deepEqual(r.planCheck, { scenes: 50, plan: 'creator', cap: 25, exceeds: true, smallestFit: 'professional' })
})

test('plan check: extra scenes count towards the cap', () => {
  const answers: Answers = { clientType: 'owner', details: { size: '3br', purpose: 'let' }, addons: { extra_scene_home: 6 }, location: nairobi }
  const r = price(modules.homes, answers, rateTableV1, { plan: 'creator' })
  assert.equal(r.planCheck.scenes, 26)
  assert.equal(r.planCheck.exceeds, true)
  assert.equal(r.options[1].total, 9000 + 6 * 500)
})

// ── Edge cases ──────────────────────────────────────────────────────────────

test('edge: missing answers give no price and list what is missing', () => {
  const r = price(modules.homes, { clientType: 'owner', details: {} }, rateTableV1)
  assert.equal(r.mode, 'custom')
  assert.deepEqual(r.options, [])
  assert.ok(r.missing.includes('size'))
})

test('edge: zero scenes on Other still drafts the minimum job price', () => {
  const r = price(modules.other, { details: { description: 'A boat yard', areas: 0 }, location: nairobi }, rateTableV1)
  assert.equal(r.mode, 'custom')
  assert.ok(r.warnings.some(w => w.code === 'scenes_missing'))
  assert.equal(r.options[0].tier, 'draft')
  assert.equal(r.options[0].total, 7000)
})

test('edge: Other drafts scenes × the business rate, never shown to the visitor', () => {
  const r = price(modules.other, { details: { description: 'Church hall', areas: 12 }, location: nairobi }, rateTableV1)
  assert.equal(r.mode, 'custom')
  assert.deepEqual(r.flags, ['new_industry'])
  assert.equal(r.options[0].total, 12 * 800)
})

test('edge: Other below the minimum gets a minimum adjustment line', () => {
  const r = price(modules.other, { details: { description: 'Kiosk', areas: 3 }, location: nairobi }, rateTableV1)
  const min = r.options[0].lines.find(l => l.kind === 'minimum')
  assert.equal(min?.amount, 7000 - 2400)
  assert.equal(r.options[0].total, 7000)
})

test('edge: far locations switch to a staff-confirmed estimate', () => {
  const r = price(modules.homes, { ...examples[0].answers, location: { town: 'Mombasa' } }, rateTableV1)
  assert.equal(r.mode, 'range')
  assert.equal(r.options.length, 1)
  assert.equal(r.options[0].tier, 'estimate')
  assert.ok(r.options[0].lines.some(l => l.kind === 'travel' && l.tbc))
  assert.ok(r.warnings.some(w => w.code === 'travel_far' && w.data?.perDiem === 1500))
})

test('edge: a location we cannot place is confirmed by staff', () => {
  const r = price(modules.homes, { ...examples[0].answers, location: { town: 'Somewhere new' } }, rateTableV1)
  assert.equal(r.mode, 'range')
  assert.ok(r.warnings.some(w => w.code === 'location_unresolved'))
})

test('edge: custom sizes (200+ room hotel) go to staff with a draft from the "from" price', () => {
  const r = price(modules.hotels, { details: { kind: 'hotel', rooms_hotel: '200plus' }, location: nairobi }, rateTableV1)
  assert.equal(r.mode, 'custom')
  assert.equal(r.options[0].total, 120000)
})

test('edge: discounts over the 20% cap are capped', () => {
  const answers: Answers = { clientType: 'agent', details: { size: '1br', purpose: 'let', listings: 20, same_building: 20 }, location: nairobi }
  const r = price(modules.homes, answers, rateTableV1)
  const o = r.options[0]
  // Same-building ladder is 4 × 15% + 15 × 25% over 20 units = 21.75%, above the cap
  assert.equal(o.subtotal, 110000)
  assert.equal(o.discountBp, 2000)
  assert.equal(o.total, 88000)
  assert.ok(r.warnings.some(w => w.code === 'discount_capped' && w.data?.requestedBp === 2175))
})

test('edge: only an admin with a reason can lift the cap', () => {
  const answers: Answers = { clientType: 'agent', details: { size: '1br', purpose: 'let', listings: 20, same_building: 20 }, location: nairobi }
  const admin = price(modules.homes, answers, rateTableV1, { discountOverride: { capBp: 2500, reason: 'Framework agreement', byRole: 'admin' } })
  assert.equal(admin.options[0].discount, 23925)
  const sales = price(modules.homes, answers, rateTableV1, { discountOverride: { capBp: 2500, reason: 'Please', byRole: 'sales' } })
  assert.equal(sales.options[0].discountBp, 2000)
  assert.ok(sales.warnings.some(w => w.code === 'override_not_allowed'))
  const noReason = price(modules.homes, answers, rateTableV1, { discountOverride: { capBp: 2500, reason: ' ', byRole: 'admin' } })
  assert.equal(noReason.options[0].discountBp, 2000)
})

test('edge: discount rules do not stack; the best one wins', () => {
  // 10 listings, 3 in one building: pack 15% (10,500) beats same-building (2 × 15% of 7,000 = 2,100)
  const answers: Answers = { clientType: 'agent', details: { size: '2br', purpose: 'let', listings: 10, same_building: 3 }, location: nairobi }
  const o = price(modules.homes, answers, rateTableV1).options[0]
  assert.equal(o.discount, 10500)
  assert.deepEqual(o.lines.filter(l => l.kind === 'discount').map(l => l.key), ['pack_10'])
})

test('edge: rush delivery is 30% of the job and its add-ons', () => {
  const answers: Answers = { clientType: 'owner', details: { size: '2br', purpose: 'let' }, addons: { photos_20: 1, rush: 1 }, location: nairobi }
  const o = price(modules.homes, answers, rateTableV1).options[1]
  assert.equal(o.total, 7000 + 4000 + 3300)
})

test('edge: add-ons the module does not offer are ignored', () => {
  const answers: Answers = { clientType: 'owner', details: { size: 'studio', purpose: 'let' }, addons: { airbnb_pro_pack: 1, nonsense: 3 }, location: nairobi }
  assert.equal(price(modules.homes, answers, rateTableV1).options[1].total, 4500)
})

// ── Tax, currency and versioning ────────────────────────────────────────────

test('VAT: off by default and stated on the result; 16% when on', () => {
  const off = price(modules.homes, examples[0].answers, rateTableV1)
  assert.deepEqual(off.vat, { charged: false, rateBp: 1600 })
  assert.equal(off.options[0].vat, 0)
  const on = price(modules.homes, examples[0].answers, rateTableV1, { vat: true })
  assert.equal(on.options[0].vat, 720)
  assert.equal(on.options[0].total, 5220)
})

test('USD: amounts are converted to integer cents with the rate recorded', () => {
  const r = price(modules.homes, examples[0].answers, rateTableV1, { currency: 'USD' })
  assert.equal(r.currency, 'USD')
  assert.equal(r.fxRate, 130)
  assert.equal(r.options[0].total, 3462)
})

test('versioning: a result keeps the rate table version and never changes after a price edit', () => {
  const before = price(modules.homes, examples[0].answers, rateTableV1)
  const v2: RateTable = structuredClone(rateTableV1)
  v2.id = 'v2'; v2.version = 2
  v2.items.home_studio = { ...v2.items.home_studio, low: 5000, high: 5000 }
  const after = price(modules.homes, examples[0].answers, v2)
  assert.equal(before.rateTableVersion, 1)
  assert.equal(before.options[0].total, 4500)
  assert.equal(after.rateTableVersion, 2)
  assert.equal(after.options[0].total, 5000)
  assert.equal(rateTableV1.items.home_studio.low, 4500)
})

test('ranges: the admin chooses which end of a range the engine charges', () => {
  const answers: Answers = { clientType: 'owner', details: { size: 'studio', purpose: 'let' }, addons: { video: 1 }, location: nairobi }
  const high: RateTable = structuredClone(rateTableV1)
  high.items.video.use = 'high'
  assert.equal(price(modules.homes, answers, rateTableV1).options[1].total, 4500 + 8000)
  assert.equal(price(modules.homes, answers, high).options[1].total, 4500 + 15000)
})

// ── Modules, zones and phones ───────────────────────────────────────────────

test('modules: every rate key and question reference exists', () => {
  for (const m of Object.values(modules)) assert.deepEqual(validateModule(m, rateTableV1), [], m.key)
})

test('zones: map pins use distance from Nairobi CBD', () => {
  assert.equal(resolveZone({ lat: -1.2676, lng: 36.8108 }, rateTableV1), 'travel_nairobi')   // Westlands
  assert.equal(resolveZone({ lat: -0.7172, lng: 36.4310 }, rateTableV1), 'travel_regional')  // Naivasha
  assert.equal(resolveZone({ lat: -4.0435, lng: 39.6682 }, rateTableV1), 'travel_far')       // Mombasa
  assert.equal(resolveZone(undefined, rateTableV1), null)
})

test('phone: Kenyan numbers normalise to +254', () => {
  for (const input of ['0712 345 678', '+254 712-345-678', '254712345678', '712345678', '+254 0712345678', '00254712345678']) {
    assert.deepEqual(normalisePhone(input), { ok: true, e164: '+254712345678', kenyan: true }, input)
  }
  assert.deepEqual(normalisePhone('0110 123 456'), { ok: true, e164: '+254110123456', kenyan: true })
})

test('phone: friendly reasons for numbers we cannot use', () => {
  assert.deepEqual(normalisePhone(''), { ok: false, reason: 'empty' })
  assert.deepEqual(normalisePhone('07123'), { ok: false, reason: 'too_short' })
  assert.deepEqual(normalisePhone('07123456789'), { ok: false, reason: 'too_long' })
  assert.deepEqual(normalisePhone('0812345678'), { ok: false, reason: 'not_mobile' })
  assert.deepEqual(normalisePhone('call me'), { ok: false, reason: 'invalid' })
  assert.deepEqual(normalisePhone('+44 7911 123456'), { ok: true, e164: '+447911123456', kenyan: false })
})
