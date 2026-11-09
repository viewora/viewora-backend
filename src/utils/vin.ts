// VINs and chassis numbers. A 17-character VIN (ISO 3779: no I, O or Q) can be decoded
// with NHTSA's free vPIC service, which knows most makes sold worldwide, not only the US.
// Japanese-market imports carry a short chassis number instead ("NZE141-1234567"):
// those are stored as typed and the owner fills make and model by hand.

export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/
/** Anything a car might carry: a VIN or a chassis number (letters, digits, hyphens). */
export const CHASSIS_RE = /^[A-Z0-9][A-Z0-9-]{4,24}$/

export function normalizeVin(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, '')
}

export function isDecodableVin(vin: string): boolean {
  return VIN_RE.test(vin)
}

export interface DecodedVin {
  vin: string
  make: string | null
  model: string | null
  trim: string | null
  year: number | null
  fuel_type: 'petrol' | 'diesel' | 'electric' | 'hybrid' | null
  transmission: 'manual' | 'automatic' | null
  body: string | null
}

const KEEP_UPPER = new Set(['BMW', 'GMC', 'MINI', 'RAM', 'MG', 'BYD', 'DS', 'SEAT', 'VW', 'AMG'])

/** vPIC returns makes in capitals: "PORSCHE" → "Porsche", "MERCEDES-BENZ" → "Mercedes-Benz", "BMW" stays. */
export function tidyMake(raw: string): string {
  return raw.trim().split(/(\s+|-)/).map(w => (KEEP_UPPER.has(w.toUpperCase()) || !/[A-Z]/i.test(w)
    ? w.toUpperCase()
    : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('')
}

const clean = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s && s !== 'Not Applicable' && s !== '0' ? s : null
}

/** One row of vPIC's DecodeVinValues → the fields the editor fills. Null when vPIC knows nothing. */
export function parseVpic(vin: string, row: Record<string, unknown> | undefined): DecodedVin | null {
  if (!row) return null
  const make = clean(row.Make)
  if (!make) return null
  const fuel = `${clean(row.FuelTypePrimary) ?? ''} ${clean(row.FuelTypeSecondary) ?? ''} ${clean(row.ElectrificationLevel) ?? ''}`.toLowerCase()
  const fuel_type = /hybrid|hev/.test(fuel) ? 'hybrid'
    : /electric/.test(fuel) && !/gasoline|diesel/.test(fuel) ? 'electric'
      : /diesel/.test(fuel) ? 'diesel'
        : /gasoline|petrol|ethanol|flex/.test(fuel) ? 'petrol' : null
  const trans = (clean(row.TransmissionStyle) ?? '').toLowerCase()
  const transmission = /manual/.test(trans) ? 'manual' : /auto|cvt|dual|dct/.test(trans) ? 'automatic' : null
  const year = Number(clean(row.ModelYear))
  // "Carrera Cabriolet / 4 Cabriolet" is vPIC listing every trim the VIN could be: keep the first.
  const trim = (clean(row.Trim) ?? clean(row.Series))?.split(' / ')[0]?.trim() || null
  return {
    vin,
    make: tidyMake(make),
    model: clean(row.Model),
    trim: trim ? trim.slice(0, 60) : null,
    year: Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null,
    fuel_type,
    transmission,
    body: clean(row.BodyClass),
  }
}

export async function decodeVin(vin: string, fetchImpl: typeof fetch = fetch): Promise<DecodedVin | null> {
  const res = await fetchImpl(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`, {
    signal: AbortSignal.timeout(8000),
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`vPIC ${res.status}`)
  const json: any = await res.json()
  return parseVpic(vin, json?.Results?.[0])
}
