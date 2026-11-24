import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkSample, csvToListings, formatReport, jsonToListings, parseCsv } from '../partners/sampleCheck.js'

test('CSV parser handles quotes, commas, escaped quotes, CRLF and a BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""",\r\n\r\n"multi\nline",2,3')
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', ''], ['multi\nline', '2', '3']])
})

test('CSV rows become listings: dotted headers, numbers, lists, ids kept as text', () => {
  const [l] = csvToListings(
    'external_id,price.amount,price.currency,publish,property.amenities,vehicle.registration_no,media.1.kind\n' +
    '00123,"85,000",KES,yes,borehole| lift ,KDA123A,photo')
  assert.equal(l.external_id, '00123', 'leading zeros survive')
  assert.deepEqual(l.price, { amount: 85000, currency: 'KES' })
  assert.equal(l.publish, true)
  assert.deepEqual((l as any).property.amenities, ['borehole', 'lift'])
  assert.equal((l as any).vehicle.registration_no, 'KDA123A')
  assert.deepEqual(l.media, [{ kind: 'photo' }], 'gaps in media are dropped')
})

test('decimal money in a spreadsheet is reported, not rounded', () => {
  const r = checkSample(csvToListings(
    'external_id,vertical,transaction,title,price.amount,price.currency,price.period,location.county,location.area,property.property_type,property.bedrooms\n' +
    'A1,property,rent,Flat,85000.50,KES,month,Nairobi,Kilimani,apartment,2'))
  assert.equal(r.valid, 0)
  assert.equal(r.reports[0].problems[0].field, 'price.amount')
})

test('the template CSV in docs is valid and ready to publish', () => {
  const text = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'partner-sample-template.csv'), 'utf8')
  const r = checkSample(csvToListings(text))
  assert.equal(r.rows, 2)
  assert.equal(r.valid, 2, formatReport(r))
  assert.equal(r.publishable, 1, 'the car has 3 photos and needs 4')
  assert.deepEqual(r.reports[1].problems.map(p => p.field), ['media'])
})

test('report counts problems, repeats and readiness', () => {
  const good = {
    external_id: 'H1', vertical: 'property', transaction: 'sale', title: 'House',
    price: { amount: 12_000_000, currency: 'KES' }, location: { county: 'Kiambu', area: 'Ruiru' },
    property: { property_type: 'house', bedrooms: 3 },
    media: [1, 2, 3].map(n => ({ kind: 'photo', source_url: `https://x.co.ke/${n}.jpg` })),
  }
  const r = checkSample([
    good,
    { ...good, media: [] },                                  // valid, not publishable
    { ...good, external_id: 'H1', location: { county: 'Westlands', area: 'x' } }, // repeat + bad county
    { ...good, external_id: 'H4', title: '' },
  ])
  assert.equal(r.rows, 4)
  assert.equal(r.valid, 2)
  assert.equal(r.publishable, 1)
  assert.deepEqual(r.duplicates, ['H1 (rows 1 and 2)', 'H1 (rows 1 and 3)'])
  assert.deepEqual(r.topProblems.map(p => p.field).sort(), ['location.county', 'media', 'title'])
  const text = formatReport(r)
  assert.match(text, /Listings checked: 4/)
  assert.match(text, /Ready to publish: 1 \(25%\)/)
})

test('JSON input: an array, { items } or { listings }', () => {
  assert.equal(jsonToListings('[{"a":1}]').length, 1)
  assert.equal(jsonToListings('{"items":[{},{}]}').length, 2)
  assert.equal(jsonToListings('{"listings":[{}]}').length, 1)
  assert.throws(() => jsonToListings('{"data":1}'), /Expected a JSON array/)
})
