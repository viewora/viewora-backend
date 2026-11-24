import { listingInputSchema, publishBlockers, type MediaCounts } from './listingModel.js'

// Phase 0 tool: checks a design partner's real listings against the listing
// model before any integration is built. Staff run it on an export (JSON or
// CSV); it reports which rows are valid, which could be published, and which
// fields are missing most often. Nothing is sent anywhere.

export type RowReport = {
  row: number
  external_id: string | null
  valid: boolean
  publishable: boolean
  problems: { field: string; message: string }[]
}

export type SampleReport = {
  rows: number
  valid: number
  publishable: number
  duplicates: string[]
  topProblems: { field: string; count: number }[]
  reports: RowReport[]
}

// ── CSV ──────────────────────────────────────────────────────────────────────
/** RFC 4180 CSV: quoted fields, "" escapes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(v => v !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(v => v !== '')) rows.push(row)
  return rows
}

// Columns that hold numbers or true/false; everything else stays text, so an
// id like "00123" or a plate like "KDA123A" is never turned into a number.
const NUMBER_PATHS = new Set([
  'price.amount', 'deposit.amount', 'service_charge.amount', 'location.lat', 'location.lng',
  'property.bedrooms', 'property.bathrooms', 'property.en_suite', 'property.floor_area_sqm', 'property.plot_size_acres',
  'property.floor', 'property.total_floors', 'property.parking_spaces',
  'vehicle.year', 'vehicle.mileage_km', 'vehicle.engine_cc',
])
const BOOLEAN_PATHS = new Set(['price.negotiable', 'price.vat_inclusive', 'price_on_request', 'vehicle.duty_paid', 'publish'])
// One cell, several values separated by |
const LIST_PATHS = new Set(['property.amenities'])

function cellValue(path: string, raw: string): unknown {
  const v = raw.trim()
  const generic = path.replace(/\.\d+\./g, '.N.')
  if (NUMBER_PATHS.has(path) || generic === 'media.N.order' || generic === 'media.N.angle') {
    // Spreadsheets write 85,000 or 85000.00: accept the separators, keep decimals so the model can refuse them.
    const n = Number(v.replace(/,/g, ''))
    return Number.isFinite(n) ? n : v
  }
  if (BOOLEAN_PATHS.has(path)) {
    if (/^(true|yes|y|1)$/i.test(v)) return true
    if (/^(false|no|n|0)$/i.test(v)) return false
    return v
  }
  if (LIST_PATHS.has(path)) return v.split('|').map(s => s.trim()).filter(Boolean)
  return v
}

function setPath(obj: Record<string, any>, path: string, value: unknown) {
  const parts = path.split('.')
  let cur: any = obj
  parts.forEach((p, i) => {
    const key: string | number = /^\d+$/.test(p) ? Number(p) : p
    if (i === parts.length - 1) { cur[key] = value; return }
    const nextIsIndex = /^\d+$/.test(parts[i + 1])
    cur[key] ??= nextIsIndex ? [] : {}
    cur = cur[key]
  })
}

/** CSV with dotted headers (price.amount, location.county, media.0.source_url) → listing objects. Empty cells are left out. */
export function csvToListings(text: string): Record<string, unknown>[] {
  const [header, ...rows] = parseCsv(text)
  if (!header) return []
  const cols = header.map(h => h.trim())
  return rows.map(cells => {
    const obj: Record<string, unknown> = {}
    cols.forEach((col, i) => {
      const raw = cells[i] ?? ''
      if (col && raw.trim() !== '') setPath(obj, col, cellValue(col, raw))
    })
    // Spreadsheet gaps leave holes in media arrays.
    if (Array.isArray(obj.media)) obj.media = (obj.media as unknown[]).filter(Boolean)
    return obj
  })
}

/** Accepts [listing, …], { items: [...] } or { listings: [...] }. */
export function jsonToListings(text: string): Record<string, unknown>[] {
  const data = JSON.parse(text.replace(/^﻿/, ''))
  const list = Array.isArray(data) ? data : data?.items ?? data?.listings
  if (!Array.isArray(list)) throw new Error('Expected a JSON array, or an object with "items" or "listings"')
  return list
}

// ── The check ────────────────────────────────────────────────────────────────
function mediaCounts(media: unknown): MediaCounts {
  const counts: MediaCounts = { photo: 0, panorama: 0, tour: 0, car_exterior: 0 }
  if (Array.isArray(media)) for (const m of media) {
    const k = (m as any)?.kind
    if (k in counts) counts[k as keyof MediaCounts]++
  }
  return counts
}

export function checkSample(listings: Record<string, unknown>[]): SampleReport {
  const seen = new Map<string, number>()
  const duplicates: string[] = []
  const problemCounts = new Map<string, number>()

  const reports = listings.map((raw, i): RowReport => {
    const row = i + 1
    const ext = typeof raw?.external_id === 'string' || typeof raw?.external_id === 'number' ? String(raw.external_id) : null
    if (ext) {
      if (seen.has(ext)) duplicates.push(`${ext} (rows ${seen.get(ext)} and ${row})`)
      else seen.set(ext, row)
    }
    const problems: { field: string; message: string }[] = []
    const parsed = listingInputSchema.safeParse(raw)
    let publishable = false
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push({ field: issue.path.join('.') || '(listing)', message: issue.message })
    } else {
      const blockers = publishBlockers(parsed.data, mediaCounts(parsed.data.media))
      publishable = blockers.length === 0
      for (const b of blockers) problems.push({ field: b.field, message: b.message })
    }
    for (const p of problems) {
      const key = p.field.replace(/\.\d+(\.|$)/g, '.N$1')
      problemCounts.set(key, (problemCounts.get(key) ?? 0) + 1)
    }
    return { row, external_id: ext, valid: parsed.success, publishable, problems }
  })

  return {
    rows: reports.length,
    valid: reports.filter(r => r.valid).length,
    publishable: reports.filter(r => r.publishable).length,
    duplicates,
    topProblems: [...problemCounts].map(([field, count]) => ({ field, count })).sort((a, b) => b.count - a.count || a.field.localeCompare(b.field)),
    reports,
  }
}

/** Plain-text report for staff. */
export function formatReport(r: SampleReport, maxRows = 50): string {
  const pct = (n: number) => (r.rows ? Math.round((n / r.rows) * 100) : 0)
  const lines = [
    `Listings checked: ${r.rows}`,
    `Valid:            ${r.valid} (${pct(r.valid)}%)`,
    `Ready to publish: ${r.publishable} (${pct(r.publishable)}%)`,
    '',
  ]
  if (r.duplicates.length) lines.push(`Repeated external_id: ${r.duplicates.join('; ')}`, '')
  if (r.topProblems.length) {
    lines.push('Most common problems (field: rows affected)')
    for (const p of r.topProblems.slice(0, 15)) lines.push(`  ${p.field}: ${p.count}`)
    lines.push('')
  }
  const bad = r.reports.filter(x => x.problems.length)
  if (bad.length) {
    lines.push(`Rows with problems (first ${Math.min(maxRows, bad.length)} of ${bad.length})`)
    for (const x of bad.slice(0, maxRows)) {
      lines.push(`  Row ${x.row}${x.external_id ? ` (${x.external_id})` : ''}:`)
      for (const p of x.problems) lines.push(`    ${p.field}: ${p.message}`)
    }
  } else {
    lines.push('No problems found.')
  }
  return lines.join('\n')
}
