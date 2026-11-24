import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FIELD_OWNER, KENYA_COUNTIES, checkPatchOwnership, hashVehicleId, isRiskyPriceChange, isStaleUpdate,
  listingInputSchema, listingPatchSchema, mergePatch, normaliseCounty, parseIfMatch, publishBlockers,
  toCarIdentity, toSpaceFacts, toStateRow, type ListingInput, type MediaCounts,
} from '../partners/listingModel.js'

// The two examples from the strategy doc, section 6.
const rental = {
  external_id: 'HSE-0042',
  agent_external_id: 'agent-118',
  branch: { external_id: 'BR-WL', name: 'Westlands office', town: 'Nairobi' },
  vertical: 'property',
  transaction: 'rent',
  title: '2-bedroom apartment, Kilimani, near Yaya Centre',
  description: 'Second floor, borehole water, backup generator, lift.',
  price: { amount: 85000, currency: 'KES', period: 'month', negotiable: false },
  deposit: { amount: 170000, currency: 'KES' },
  service_charge: { amount: 8000, currency: 'KES', period: 'month' },
  availability: 'available',
  available_from: '2026-12-01',
  location: { county: 'Nairobi', area: 'Kilimani', estate: 'Argwings Kodhek Rd', lat: -1.2921, lng: 36.7848, display_precision: 'approx_500m' },
  property: {
    property_type: 'apartment', bedrooms: 2, bathrooms: 2, en_suite: 1, floor_area_sqm: 110, floor: 2, total_floors: 8,
    parking_spaces: 1, furnished: 'no', amenities: ['borehole', 'backup_generator', 'lift', 'cctv', 'gym'],
  },
  media: [
    { kind: 'photo', source_url: 'https://cdn.partner.co.ke/hse-0042/1.jpg', order: 1, caption: 'Living room' },
    { kind: 'panorama', source_url: 'https://cdn.partner.co.ke/hse-0042/lounge-360.jpg', order: 2 },
  ],
  partner_updated_at: '2026-11-20T08:14:00Z',
  publish: true,
}

const prado = {
  external_id: 'STK-2291',
  agent_external_id: 'dealer-7',
  vertical: 'vehicle',
  transaction: 'sale',
  title: 'Toyota Land Cruiser Prado TX 2019',
  price: { amount: 6450000, currency: 'KES', period: 'once', negotiable: true },
  availability: 'available',
  location: { county: 'Nairobi', area: 'Mombasa Road', display_precision: 'exact', lat: -1.3215, lng: 36.8742 },
  vehicle: {
    make: 'Toyota', model: 'Land Cruiser Prado', variant: 'TX', year: 2019, mileage_km: 68000,
    transmission: 'automatic', fuel_type: 'diesel', engine_cc: 2800, body_type: 'suv', drive: '4wd',
    colour: 'pearl white', condition: 'foreign_used', chassis_no: 'gdj150-0012345', duty_paid: true,
  },
  media: [
    { kind: 'car_exterior', source_url: 'https://img.dealer.co.ke/2291/front.jpg', angle: 0 },
    { kind: 'car_exterior', source_url: 'https://img.dealer.co.ke/2291/side.jpg', angle: 90 },
  ],
  partner_updated_at: '2026-11-21T10:02:11Z',
  publish: true,
}

const parse = (v: unknown) => listingInputSchema.safeParse(v)
const ok = (v: unknown): ListingInput => {
  const r = parse(v)
  assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2))
  return r.data
}
const issuePaths = (v: unknown) => {
  const r = parse(v)
  assert.ok(!r.success, 'expected a validation error')
  return r.error.issues.map(i => i.path.join('.'))
}
const noMedia: MediaCounts = { photo: 0, panorama: 0, tour: 0, car_exterior: 0 }

// ── Schema ───────────────────────────────────────────────────────────────────
test('the doc examples are valid listings', () => {
  ok(rental)
  const car = ok(prado)
  assert.equal(car.vehicle?.chassis_no, 'GDJ150-0012345', 'chassis number is upper-cased')
})

test('money must be a whole number', () => {
  assert.deepEqual(issuePaths({ ...rental, price: { ...rental.price, amount: 85000.5 } }), ['price.amount'])
  assert.deepEqual(issuePaths({ ...rental, price: { ...rental.price, amount: '85000' } }), ['price.amount'])
  assert.deepEqual(issuePaths({ ...rental, price: { ...rental.price, amount: -1 } }), ['price.amount'])
})

test('price period must match the transaction', () => {
  assert.deepEqual(issuePaths({ ...rental, price: { ...rental.price, period: 'once' } }), ['price.period'])
  assert.deepEqual(issuePaths({ ...prado, price: { ...prado.price, period: 'month' } }), ['price.period'])
  // A sale price defaults to once.
  const { period: _p, ...noPeriod } = prado.price
  assert.equal(ok({ ...prado, price: noPeriod }).price?.period, 'once')
})

test('deposit and service charge share the price currency and need a price', () => {
  assert.deepEqual(issuePaths({ ...rental, deposit: { amount: 1000, currency: 'USD' } }), ['deposit.currency'])
  const { price: _price, ...noPrice } = rental
  assert.ok(issuePaths(noPrice).includes('deposit'))
  assert.deepEqual(issuePaths({ ...rental, price_on_request: true }), ['price_on_request'])
})

test('vertical and its block must agree', () => {
  assert.ok(issuePaths({ ...rental, vehicle: prado.vehicle }).includes('vehicle'))
  const { property: _p, ...noBlock } = rental
  assert.deepEqual(issuePaths(noBlock), ['property'])
  assert.deepEqual(issuePaths({ ...prado, transaction: 'rent', price: { ...prado.price, period: 'day' } }), ['transaction'])
})

test('unknown fields are refused, not ignored', () => {
  assert.deepEqual(issuePaths({ ...rental, colour_of_door: 'blue' }), [''])
  assert.deepEqual(issuePaths({ ...rental, property: { ...rental.property, jacuzzi: true } }), ['property'])
})

test('counties are normalised and checked', () => {
  assert.equal(KENYA_COUNTIES.length, 47)
  assert.equal(normaliseCounty('nairobi city'), 'Nairobi')
  assert.equal(normaliseCounty('MURANGA'), "Murang'a")
  assert.equal(normaliseCounty('Uasin-Gishu'), 'Uasin Gishu')
  assert.equal(normaliseCounty('Westlands'), null)
  assert.equal(ok({ ...rental, location: { ...rental.location, county: 'kiambu' } }).location?.county, 'Kiambu')
  assert.deepEqual(issuePaths({ ...rental, location: { ...rental.location, county: 'Westlands' } }), ['location.county'])
})

test('location needs lat and lng together, and defaults to an approximate pin', () => {
  assert.deepEqual(issuePaths({ ...rental, location: { county: 'Nairobi', area: 'Kilimani', lat: -1.29 } }), ['location.lat'])
  assert.equal(ok({ ...rental, location: { county: 'Nairobi', area: 'Kilimani' } }).location?.display_precision, 'approx_500m')
})

test('descriptions are stored as plain text', () => {
  const l = ok({ ...rental, description: '<p>Lovely <b>2-bed</b></p><script>x()</script>' })
  assert.equal(l.description, 'Lovely 2-bed x()')
})

test('media URLs must be https, and car photos need an angle', () => {
  assert.deepEqual(issuePaths({ ...rental, media: [{ kind: 'photo', source_url: 'http://x.co.ke/a.jpg' }] }), ['media.0.source_url'])
  assert.deepEqual(issuePaths({ ...prado, media: [{ kind: 'car_exterior', source_url: 'https://x.co.ke/a.jpg' }] }), ['media.0.angle'])
  assert.deepEqual(issuePaths({ ...rental, media: [{ kind: 'photo' }] }), ['media.0.source_url'])
})

test('VIN rules: 17 characters without I, O or Q', () => {
  assert.equal(ok({ ...prado, vehicle: { ...prado.vehicle, vin: 'jtebh3fj10k123456' } }).vehicle?.vin, 'JTEBH3FJ10K123456')
  assert.deepEqual(issuePaths({ ...prado, vehicle: { ...prado.vehicle, vin: 'JTEBH3FJ1OK123456' } }), ['vehicle.vin'])
  assert.deepEqual(issuePaths({ ...prado, vehicle: { ...prado.vehicle, vin: 'SHORT' } }), ['vehicle.vin'])
})

test('availability defaults to available and publish to false', () => {
  const { availability: _a, publish: _p, ...rest } = rental
  const l = ok(rest)
  assert.equal(l.availability, 'available')
  assert.equal(l.publish, false)
})

// ── PATCH ────────────────────────────────────────────────────────────────────
test('a PATCH applies no defaults', () => {
  const p = listingPatchSchema.parse({ price: { amount: 80000, currency: 'KES', period: 'month' } })
  assert.equal(p.availability, undefined)
  assert.equal(p.publish, undefined)
})

test('mergePatch changes only what was sent, null clears, and the result is re-checked', () => {
  const stored = ok(rental)
  const r = mergePatch(stored, listingPatchSchema.parse({ availability: 'rented', deposit: null }))
  assert.ok(r.ok)
  if (r.ok) {
    assert.equal(r.listing.availability, 'rented')
    assert.equal(r.listing.deposit, undefined)
    assert.equal(r.listing.price?.amount, 85000)
  }
  // Removing the price while a deposit is still set breaks a cross-field rule.
  const bad = mergePatch(stored, listingPatchSchema.parse({ price: null }))
  assert.equal(bad.ok, false)
})

test('ownership: Viewora-owned and fixed fields are refused with a clear code', () => {
  assert.deepEqual(checkPatchOwnership({ price: {}, availability: 'sold' }, 'api'), { ok: true })

  const owned = checkPatchOwnership({ price: {}, publication_status: 'published', version: 9 }, 'api')
  assert.equal(owned.ok, false)
  if (!owned.ok) {
    assert.equal(owned.code, 'FIELD_OWNED_BY_OTHER')
    assert.deepEqual(owned.fields, ['publication_status', 'version'])
  }

  const fixed = checkPatchOwnership({ vertical: 'vehicle' }, 'api')
  assert.ok(!fixed.ok && fixed.code === 'FIELD_IMMUTABLE')

  const app = checkPatchOwnership({ price: {} }, 'app')
  assert.ok(!app.ok && app.code === 'LISTING_OWNED_BY_VIEWORA')
})

test('every field a partner can send is partner-owned, and every PATCH field too', () => {
  for (const k of Object.keys(listingInputSchema.shape)) {
    assert.equal(FIELD_OWNER[k], 'partner', k)
  }
  for (const k of Object.keys(listingPatchSchema.shape)) assert.equal(FIELD_OWNER[k], 'partner', k)
})

// ── Publishing ───────────────────────────────────────────────────────────────
test('publish needs a price, location, bedrooms and enough media', () => {
  const l = ok(rental)
  assert.deepEqual(publishBlockers(l, { ...noMedia, photo: 3 }), [])
  assert.deepEqual(publishBlockers(l, { ...noMedia, tour: 1 }), [], 'one tour is enough')
  assert.deepEqual(publishBlockers(l, { ...noMedia, photo: 2 }).map(b => b.code), ['NOT_ENOUGH_MEDIA'])

  const { price: _p, deposit: _d, service_charge: _s, location: _l, ...bare } = rental
  const fields = publishBlockers(ok({ ...bare, property: { property_type: 'house' } }), { ...noMedia, photo: 5 }).map(b => b.field)
  assert.deepEqual(fields, ['price', 'location', 'property.bedrooms'])

  // Land has no bedrooms to count; price on request is allowed for property.
  const land = ok({ ...bare, location: rental.location, price_on_request: true, property: { property_type: 'land', plot_size_acres: 0.5 } })
  assert.deepEqual(publishBlockers(land, { ...noMedia, photo: 3 }), [])
})

test('a vehicle needs mileage, transmission, fuel, a price and 4 photos', () => {
  const car = ok(prado)
  assert.deepEqual(publishBlockers(car, { ...noMedia, car_exterior: 2, photo: 2 }), [])
  const { mileage_km: _m, transmission: _t, ...thin } = prado.vehicle
  const fields = publishBlockers(ok({ ...prado, vehicle: thin }), { ...noMedia, car_exterior: 1 }).map(b => b.field)
  assert.deepEqual(fields, ['vehicle.mileage_km', 'vehicle.transmission', 'media'])
})

// ── Write rules ──────────────────────────────────────────────────────────────
test('an older partner update is stale', () => {
  assert.equal(isStaleUpdate('2026-11-20T08:14:00Z', '2026-11-20T08:13:59Z'), true)
  assert.equal(isStaleUpdate('2026-11-20T08:14:00Z', '2026-11-20T08:14:00Z'), false, 'same time is a safe retry')
  assert.equal(isStaleUpdate('2026-11-20T08:14:00Z', '2026-11-20T11:14:00+03:00'), false, 'same instant in EAT')
  assert.equal(isStaleUpdate(null, '2026-11-20T08:14:00Z'), false)
  assert.equal(isStaleUpdate('2026-11-20T08:14:00Z', undefined), false)
})

test('If-Match accepts 3, "3" and W/"3"', () => {
  assert.equal(parseIfMatch('3'), 3)
  assert.equal(parseIfMatch('"3"'), 3)
  assert.equal(parseIfMatch('W/"12"'), 12)
  assert.equal(parseIfMatch('abc'), null)
  assert.equal(parseIfMatch(undefined), null)
})

test('risky price changes: a drop over 30%, a currency change, or too many changes', () => {
  const kes = (amount: number) => ({ amount, currency: 'KES' as const })
  assert.equal(isRiskyPriceChange(kes(100_000), kes(70_000)), false, 'exactly 30% is allowed')
  assert.equal(isRiskyPriceChange(kes(100_000), kes(69_999)), true)
  assert.equal(isRiskyPriceChange(kes(100_000), kes(500_000)), false, 'rises are not held')
  assert.equal(isRiskyPriceChange(kes(100_000), { amount: 800, currency: 'USD' }), true)
  assert.equal(isRiskyPriceChange(kes(100_000), kes(95_000), 3), true)
  assert.equal(isRiskyPriceChange(null, kes(1)), false)
  // Large amounts stay exact (well inside Number.MAX_SAFE_INTEGER).
  assert.equal(isRiskyPriceChange(kes(999_999_999_999), kes(700_000_000_000)), false)
})

test('VIN and chassis hashes ignore case, spaces and dashes', () => {
  assert.equal(hashVehicleId('gdj150-0012345'), hashVehicleId('GDJ150 0012345'))
  assert.match(hashVehicleId('JTEBH3FJ10K123456'), /^[0-9a-f]{64}$/)
})

// ── Mapping onto the existing tour ───────────────────────────────────────────
test('a rental maps onto the tour columns', () => {
  const f = toSpaceFacts(ok(rental))
  assert.equal(f.space_type, 'residential')
  assert.equal(f.price_kes, 85000)
  assert.equal(f.transaction_type, 'rent')
  assert.equal(f.price_period, 'month')
  assert.equal(f.listing_status, 'available')
  assert.equal(f.bedrooms, 2)
  assert.equal(f.area_sqm, 110)
  assert.equal(f.location_text, 'Argwings Kodhek Rd, Kilimani, Nairobi')
})

test('tour mapping: USD, reserved, withdrawn, lease and commercial', () => {
  const usd = toSpaceFacts(ok({ ...rental, price: { amount: 250000, currency: 'USD', period: 'month' }, deposit: undefined, service_charge: undefined }))
  assert.equal(usd.price_kes, null, 'the tour only shows KES; the state row keeps USD')
  assert.equal(toSpaceFacts(ok({ ...rental, availability: 'reserved' })).listing_status, 'available')
  assert.equal(toSpaceFacts(ok({ ...rental, availability: 'withdrawn' })).listing_status, null)
  assert.equal(toSpaceFacts(ok({ ...rental, transaction: 'lease' })).transaction_type, 'rent')
  assert.equal(toSpaceFacts(ok({ ...rental, property: { property_type: 'office' } })).space_type, 'commercial')
  assert.equal(toSpaceFacts(ok({ ...rental, property: { property_type: 'land' } })).space_type, 'land')
  const car = toSpaceFacts(ok(prado))
  assert.equal(car.space_type, 'automotive')
  assert.equal(car.price_period, null)
  assert.equal(car.vehicle_mileage_km, 68000)
  assert.deepEqual(toCarIdentity(ok(prado)), { vin: null, make: 'Toyota', model: 'Land Cruiser Prado', trim: 'TX' })
})

test('the state row never stores the raw VIN or chassis number', () => {
  const row = toStateRow(ok({ ...prado, vehicle: { ...prado.vehicle, vin: 'JTEBH3FJ10K123456' } }), '00000000-0000-0000-0000-000000000001')
  assert.equal(row.vin_hash, hashVehicleId('JTEBH3FJ10K123456'))
  assert.equal(row.chassis_hash, hashVehicleId('GDJ150-0012345'))
  const details = JSON.stringify(row.details)
  assert.ok(!details.includes('JTEBH3FJ10K123456') && !details.includes('GDJ150'), details)
  assert.equal((row.details as any).make, 'Toyota')
})

test('every state row column exists in migration 003', () => {
  const sql = readFileSync(join(import.meta.dirname, '..', 'utils', 'migration-partner-api-003.sql'), 'utf8')
  const table = /CREATE TABLE public\.api_listing_state \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? ''
  const columns = new Set([...table.matchAll(/^\s{2}([a-z_]+)\s+(?:UUID|TEXT|INTEGER|BIGINT|BOOLEAN|DATE|JSONB|NUMERIC|TIMESTAMPTZ)/gm)].map(m => m[1]))
  assert.ok(columns.size > 30, `parsed ${columns.size} columns`)
  for (const k of Object.keys(toStateRow(ok(rental), 'x'))) assert.ok(columns.has(k), `missing column ${k}`)
})

// ── Migration 003 hygiene ────────────────────────────────────────────────────
test('migration 003 only adds api_ tables, locks them down, and has a rollback', () => {
  const dir = join(import.meta.dirname, '..', 'utils')
  const up = readFileSync(join(dir, 'migration-partner-api-003.sql'), 'utf8').replace(/--.*$/gm, '')
  const down = readFileSync(join(dir, 'migration-partner-api-003.down.sql'), 'utf8')
  const created = [...up.matchAll(/CREATE TABLE public\.(\w+)/g)].map(m => m[1])
  assert.deepEqual(created, ['api_listing_state', 'api_audit_log', 'api_idempotency_keys'])
  assert.doesNotMatch(up, /ALTER TABLE (?!public\.api_(listing_state|audit_log|idempotency_keys)\s+ENABLE ROW LEVEL SECURITY)/, 'no existing table is altered')
  for (const t of created) {
    assert.match(up, new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`), `${t} has RLS`)
    assert.match(down, new RegExp(`DROP TABLE IF EXISTS public\\.${t}`), `${t} is dropped on rollback`)
  }
  assert.doesNotMatch(up, /CREATE POLICY/, 'no policies: only the service role reads these tables')
})
