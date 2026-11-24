// Checks a design partner's listing export against the Viewora listing model.
//
//   npm run partner:check-sample -- path/to/listings.csv
//   npm run partner:check-sample -- path/to/listings.json --json
//
// CSV headers use dotted names: external_id, vertical, transaction, title,
// price.amount, price.currency, price.period, location.county, location.area,
// property.property_type, property.bedrooms, property.amenities (a|b|c),
// vehicle.make, media.0.kind, media.0.source_url, ...
// See docs/partner-listings-model.md. Runs locally; nothing is uploaded.
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { checkSample, csvToListings, formatReport, jsonToListings } from '../partners/sampleCheck.js'

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
if (!file) {
  console.error('Usage: npm run partner:check-sample -- <listings.csv|listings.json> [--json]')
  process.exit(2)
}

const text = readFileSync(file, 'utf8')
const listings = extname(file).toLowerCase() === '.csv' ? csvToListings(text) : jsonToListings(text)
const report = checkSample(listings)
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report))
