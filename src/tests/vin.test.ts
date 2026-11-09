import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import carTourRoutes, { IdentityBody } from '../routes/carTour.js'
import { isDecodableVin, normalizeVin, parseVpic, tidyMake } from '../utils/vin.js'

const SPACE_ID = '11111111-1111-4111-8111-111111111111'

// The row vPIC returned for the CloudPano demo car's VIN pattern (2021 Porsche 911 Cabriolet).
const PORSCHE_ROW = {
  Make: 'PORSCHE', Model: '911', ModelYear: '2021', Trim: 'Carrera Cabriolet / 4 Cabriolet', Series: 'Type 992',
  FuelTypePrimary: 'Gasoline', FuelTypeSecondary: '', ElectrificationLevel: '', TransmissionStyle: 'Automatic',
  BodyClass: 'Convertible/Cabriolet', ErrorCode: '1',
}

test('a vPIC row becomes the editor\'s fields', () => {
  const d = parseVpic('WP0CA2A97MS211234', PORSCHE_ROW)!
  assert.deepEqual(
    { make: d.make, model: d.model, trim: d.trim, year: d.year, fuel: d.fuel_type, gearbox: d.transmission },
    { make: 'Porsche', model: '911', trim: 'Carrera Cabriolet', year: 2021, fuel: 'petrol', gearbox: 'automatic' },
  )
})

test('hybrids, diesels and unknown VINs', () => {
  assert.equal(parseVpic('X', { Make: 'TOYOTA', FuelTypePrimary: 'Gasoline', ElectrificationLevel: 'Strong HEV (Hybrid Electric Vehicle)' })!.fuel_type, 'hybrid')
  assert.equal(parseVpic('X', { Make: 'LAND ROVER', FuelTypePrimary: 'Diesel', TransmissionStyle: 'Manual/Standard' })!.transmission, 'manual')
  assert.equal(parseVpic('X', { Make: '', Model: '' }), null)
  assert.equal(parseVpic('X', undefined), null)
})

test('make names read naturally', () => {
  assert.equal(tidyMake('MERCEDES-BENZ'), 'Mercedes-Benz')
  assert.equal(tidyMake('LAND ROVER'), 'Land Rover')
  assert.equal(tidyMake('BMW'), 'BMW')
})

test('VIN shape: 17 characters, never I, O or Q', () => {
  assert.equal(normalizeVin(' wp0ca2a9 7ms211234 '), 'WP0CA2A97MS211234')
  assert.equal(isDecodableVin('WP0CA2A97MS211234'), true)
  assert.equal(isDecodableVin('WP0CA2A97MS21123O'), false)
  assert.equal(isDecodableVin('NZE141-1234567'), false)
})

test('identity body: chassis numbers are kept, empty strings clear, junk is refused', () => {
  const ok = IdentityBody.parse({ vin: 'nze141-1234567', make: ' Toyota ', model: '', trim: null })
  assert.deepEqual(ok, { vin: 'NZE141-1234567', make: 'Toyota', model: null, trim: null })
  assert.equal(IdentityBody.safeParse({ vin: 'not a vin!' }).success, false)
  assert.equal(IdentityBody.safeParse({ make: 'x'.repeat(41) }).success, false)
})

function stub(result: (table: string, op: string) => { data: unknown; error: unknown }) {
  return {
    from(table: string) {
      let op = 'select'
      const b: any = {}
      b.select = () => b
      for (const m of ['eq', 'in', 'order', 'limit']) b[m] = () => b
      b.update = () => { op = 'update'; return b }
      b.maybeSingle = async () => result(table, op)
      b.single = b.maybeSingle
      b.then = (res: any, rej: any) => Promise.resolve(result(table, op)).then(res, rej)
      return b
    },
  }
}

async function buildApp(supabase: any) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = { sub: 'user-1' } })
  app.decorate('supabase', supabase)
  app.decorate('redis', null as any)
  await app.register(carTourRoutes)
  return app
}

test('a chassis number is not sent to the VIN lookup', async () => {
  const app = await buildApp(stub(() => ({ data: null, error: null })))
  const res = await app.inject({ method: 'GET', url: '/vehicle/vin/NZE141-1234567' })
  assert.equal(res.statusCode, 422)
  assert.match(res.json().statusMessage, /Chassis numbers/)
})

test('saving the identity before the migration says which file to run', async () => {
  const app = await buildApp(stub(() => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'vehicle_vin' column" } })))
  const res = await app.inject({ method: 'PATCH', url: `/spaces/${SPACE_ID}/vehicle-identity`, payload: { vin: 'WP0CA2A97MS211234' } })
  assert.equal(res.statusCode, 503)
  assert.match(res.json().statusMessage, /migration-vehicle-identity\.sql/)
})

test('saving the identity returns what was stored', async () => {
  const app = await buildApp(stub(() => ({ data: { vehicle_vin: 'WP0CA2A97MS211234', vehicle_make: 'Porsche', vehicle_model: '911', vehicle_trim: null }, error: null })))
  const res = await app.inject({ method: 'PATCH', url: `/spaces/${SPACE_ID}/vehicle-identity`, payload: { make: 'Porsche', model: '911' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().vehicle, { vin: 'WP0CA2A97MS211234', make: 'Porsche', model: '911', trim: null })
})
