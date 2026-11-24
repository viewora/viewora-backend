import { createHash } from 'crypto'
import { z } from 'zod'

// The partner listing model (Phase 0 of the partner integration platform).
//
// A partner listing is ONE tour (a properties row, linked through
// api_partner_tours under the partner's external_id) plus the partner-owned
// facts in api_listing_state (migration-partner-api-003.sql). This file is
// the single source of truth for:
//   - what a partner may send (zod schemas, reused for OpenAPI later),
//   - who owns each field (partner or Viewora),
//   - what a listing needs before it can be published,
//   - how a listing maps onto the existing tour columns,
//   - the small rules every write follows (stale updates, versions, risky prices).
// No route uses it yet: Phase 1 adds /v1/listings on top of it.

// ── Enums ────────────────────────────────────────────────────────────────────
export const VERTICALS = ['property', 'vehicle'] as const
export const TRANSACTIONS = ['sale', 'rent', 'lease'] as const
export const AVAILABILITY = ['available', 'reserved', 'sold', 'rented', 'withdrawn'] as const
export const PUBLICATION_STATUSES = [
  'draft', 'submitted', 'validated', 'pending_moderation', 'published', 'rejected', 'expired', 'archived',
] as const
export const CURRENCIES = ['KES', 'USD'] as const
export const PRICE_PERIODS = ['once', 'day', 'week', 'month', 'year'] as const
export const DISPLAY_PRECISIONS = ['exact', 'approx_500m', 'area_only'] as const

export const PROPERTY_TYPES = [
  'apartment', 'house', 'townhouse', 'maisonette', 'bungalow', 'villa', 'bedsitter', 'studio',
  'land', 'office', 'shop', 'warehouse', 'commercial_other',
] as const
/** Property types that have no bedrooms to count. */
export const NON_RESIDENTIAL_TYPES: readonly PropertyType[] = ['land', 'office', 'shop', 'warehouse', 'commercial_other']
const COMMERCIAL_TYPES: readonly PropertyType[] = ['office', 'shop', 'warehouse', 'commercial_other']

export const BODY_TYPES = [
  'saloon', 'hatchback', 'suv', 'pickup', 'van', 'wagon', 'coupe', 'convertible', 'bus', 'truck', 'motorbike', 'other',
] as const
export const VEHICLE_CONDITIONS = ['new', 'foreign_used', 'locally_used'] as const
export const MEDIA_KINDS = ['photo', 'panorama', 'tour', 'car_exterior', 'floor_plan', 'video', 'document'] as const

export type Vertical = typeof VERTICALS[number]
export type Transaction = typeof TRANSACTIONS[number]
export type Availability = typeof AVAILABILITY[number]
export type PublicationStatus = typeof PUBLICATION_STATUSES[number]
export type Currency = typeof CURRENCIES[number]
export type PricePeriod = typeof PRICE_PERIODS[number]
export type PropertyType = typeof PROPERTY_TYPES[number]

// ── Kenyan counties (reference data, used to normalise spelling) ─────────────
export const KENYA_COUNTIES = [
  'Mombasa', 'Kwale', 'Kilifi', 'Tana River', 'Lamu', 'Taita-Taveta', 'Garissa', 'Wajir', 'Mandera', 'Marsabit',
  'Isiolo', 'Meru', 'Tharaka-Nithi', 'Embu', 'Kitui', 'Machakos', 'Makueni', 'Nyandarua', 'Nyeri', 'Kirinyaga',
  "Murang'a", 'Kiambu', 'Turkana', 'West Pokot', 'Samburu', 'Trans Nzoia', 'Uasin Gishu', 'Elgeyo-Marakwet', 'Nandi',
  'Baringo', 'Laikipia', 'Nakuru', 'Narok', 'Kajiado', 'Kericho', 'Bomet', 'Kakamega', 'Vihiga', 'Bungoma', 'Busia',
  'Siaya', 'Kisumu', 'Homa Bay', 'Migori', 'Kisii', 'Nyamira', 'Nairobi',
] as const

const countyKey = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
const COUNTY_BY_KEY = new Map<string, string>([
  ...KENYA_COUNTIES.map(c => [countyKey(c), c] as [string, string]),
  ['nairobicity', 'Nairobi'],
  ['muranga', "Murang'a"],
  ['taitataveta', 'Taita-Taveta'],
  ['tharakanithi', 'Tharaka-Nithi'],
  ['elgeyomarakwet', 'Elgeyo-Marakwet'],
])

/** "nairobi city" → "Nairobi"; returns null for anything that is not a county. */
export function normaliseCounty(input: string): string | null {
  return COUNTY_BY_KEY.get(countyKey(input)) ?? null
}

// ── Building blocks ──────────────────────────────────────────────────────────
/** Same pattern as the existing /v1 external ids. */
export const EXTERNAL_ID = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z0-9._:\-]+$/, 'Use letters, numbers, dot, dash, underscore or colon')

/** Largest amount accepted, the same ceiling as properties.price_kes. */
export const MAX_AMOUNT = 999_999_999_999
/** Money is an integer: whole KES, or USD cents. A float is refused, not rounded. */
export const AMOUNT = z.number().int('Amounts are whole numbers: KES in shillings, USD in cents').min(0).max(MAX_AMOUNT)

const httpsUrl = z.string().trim().url().max(2048).refine(u => u.startsWith('https://'), 'Use an https:// URL')

const text = (max: number) => z.string().trim().min(1).max(max)
// Partners paste from CRMs: strip tags so descriptions stay plain text.
const plainText = (max: number) => z.string().max(max * 2)
  .transform(s => s.replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').trim())
  .pipe(z.string().min(1).max(max))

export const priceSchema = z.object({
  amount: AMOUNT,
  currency: z.enum(CURRENCIES),
  period: z.enum(PRICE_PERIODS).default('once'),
  negotiable: z.boolean().optional(),
  vat_inclusive: z.boolean().optional(),
}).strict()

const extraChargeSchema = z.object({
  amount: AMOUNT,
  currency: z.enum(CURRENCIES),
  period: z.enum(PRICE_PERIODS).optional(),
}).strict()

export const locationSchema = z.object({
  county: z.string().trim().min(1).max(60).transform((s, ctx) => {
    const c = normaliseCounty(s)
    if (!c) {
      ctx.addIssue({ code: 'custom', message: 'Use a Kenyan county name, for example Nairobi or Kiambu' })
      return z.NEVER
    }
    return c
  }),
  area: text(120),
  estate: text(120).optional(),
  address_line: text(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  display_precision: z.enum(DISPLAY_PRECISIONS).default('approx_500m'),
}).strict().refine(l => (l.lat === undefined) === (l.lng === undefined), {
  message: 'Send lat and lng together', path: ['lat'],
})

export const branchSchema = z.object({
  external_id: EXTERNAL_ID,
  name: text(120).optional(),
  town: text(80).optional(),
}).strict()

export const propertyBlockSchema = z.object({
  property_type: z.enum(PROPERTY_TYPES),
  bedrooms: z.number().int().min(0).max(50).optional(),
  bathrooms: z.number().int().min(0).max(50).optional(),
  en_suite: z.number().int().min(0).max(50).optional(),
  floor_area_sqm: z.number().int().min(1).max(1_000_000).optional(),
  plot_size_acres: z.number().positive().max(1_000_000).optional(),
  floor: z.number().int().min(-5).max(200).optional(),
  total_floors: z.number().int().min(1).max(200).optional(),
  parking_spaces: z.number().int().min(0).max(1000).optional(),
  furnished: z.enum(['no', 'semi', 'full']).optional(),
  // Same limits as the tour's amenities column.
  amenities: z.array(text(60)).max(30).optional(),
  title_type: z.enum(['freehold', 'leasehold', 'sectional', 'other']).optional(),
}).strict()

/** 17 characters, no I, O or Q. Check digits are not enforced: Japanese imports often lack one. */
export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/
/** Japanese-style chassis numbers such as GDJ150-0012345. */
export const CHASSIS_RE = /^[A-Z0-9][A-Z0-9-]{4,29}$/

const upper = (max: number) => z.string().trim().max(max).transform(s => s.toUpperCase().replace(/\s+/g, ''))

export const vehicleBlockSchema = z.object({
  make: text(40),
  model: text(60),
  variant: text(60).optional(),
  year: z.number().int().min(1900).max(2100),
  mileage_km: z.number().int().min(0).max(10_000_000).optional(),
  // Same values as the tour columns vehicle_transmission / vehicle_fuel_type.
  transmission: z.enum(['manual', 'automatic']).optional(),
  fuel_type: z.enum(['petrol', 'diesel', 'electric', 'hybrid']).optional(),
  engine_cc: z.number().int().min(50).max(20_000).optional(),
  body_type: z.enum(BODY_TYPES).optional(),
  drive: z.enum(['2wd', '4wd', 'awd']).optional(),
  colour: text(40).optional(),
  condition: z.enum(VEHICLE_CONDITIONS).optional(),
  vin: upper(17).pipe(z.string().regex(VIN_RE, 'A VIN is 17 letters and numbers, without I, O or Q')).optional(),
  chassis_no: upper(30).pipe(z.string().regex(CHASSIS_RE, 'Use the chassis number as printed, for example GDJ150-0012345')).optional(),
  registration_no: upper(12).pipe(z.string().regex(/^[A-Z0-9]{3,12}$/, 'Use the number plate without spaces')).optional(),
  duty_paid: z.boolean().optional(),
}).strict()

export const mediaItemSchema = z.object({
  kind: z.enum(MEDIA_KINDS),
  source_url: httpsUrl.optional(),
  media_id: z.string().uuid().optional(),
  order: z.number().int().min(0).max(1000).optional(),
  caption: text(140).optional(),
  // car_exterior only: 0 = front, as the existing /v1 uploads.
  angle: z.number().int().min(0).max(359).optional(),
}).strict().superRefine((m, ctx) => {
  if (!m.source_url && !m.media_id) ctx.addIssue({ code: 'custom', message: 'Send source_url or media_id', path: ['source_url'] })
  if (m.kind === 'car_exterior' && m.angle === undefined) ctx.addIssue({ code: 'custom', message: 'car_exterior needs an angle (0 to 359)', path: ['angle'] })
  if (m.kind !== 'car_exterior' && m.angle !== undefined) ctx.addIssue({ code: 'custom', message: 'angle is only for car_exterior', path: ['angle'] })
})

/** Which price periods make sense for each transaction. */
export const PERIODS_FOR: Record<Transaction, readonly PricePeriod[]> = {
  sale: ['once'],
  rent: ['day', 'week', 'month', 'year'],
  lease: ['month', 'year'],
}

// ── The listing a partner sends ──────────────────────────────────────────────
const listingFields = {
  external_id: EXTERNAL_ID,
  agent_external_id: EXTERNAL_ID.optional(),
  branch: branchSchema.optional(),
  vertical: z.enum(VERTICALS),
  transaction: z.enum(TRANSACTIONS),
  // Same limits as the tour's title and description.
  title: text(120),
  description: plainText(2000).optional(),
  price: priceSchema.optional(),
  price_on_request: z.boolean().optional(),
  deposit: extraChargeSchema.optional(),
  service_charge: extraChargeSchema.optional(),
  availability: z.enum(AVAILABILITY).default('available'),
  available_from: z.iso.date().optional(),
  location: locationSchema.optional(),
  property: propertyBlockSchema.optional(),
  vehicle: vehicleBlockSchema.optional(),
  media: z.array(mediaItemSchema).max(60).optional(),
  partner_updated_at: z.iso.datetime({ offset: true }).optional(),
  publish: z.boolean().default(false),
}

type Ctx = z.RefinementCtx
function crossChecks(l: Partial<ListingInputShape>, ctx: Ctx) {
  if (l.vertical === 'property' && l.vehicle) ctx.addIssue({ code: 'custom', message: 'A property listing cannot have a vehicle block', path: ['vehicle'] })
  if (l.vertical === 'vehicle' && l.property) ctx.addIssue({ code: 'custom', message: 'A vehicle listing cannot have a property block', path: ['property'] })
  if (l.vertical === 'vehicle' && l.transaction && l.transaction !== 'sale') {
    // Car hire is a different product; keep v1 to sales.
    ctx.addIssue({ code: 'custom', message: 'Vehicle listings are for sale only in v1', path: ['transaction'] })
  }
  if (l.price && l.transaction && !PERIODS_FOR[l.transaction].includes(l.price.period)) {
    ctx.addIssue({ code: 'custom', path: ['price', 'period'],
      message: `For ${l.transaction}, price.period must be ${PERIODS_FOR[l.transaction].join(' or ')}` })
  }
  for (const k of ['deposit', 'service_charge'] as const) {
    const extra = l[k]
    if (extra && l.price && extra.currency !== l.price.currency) {
      ctx.addIssue({ code: 'custom', message: `${k} must be in the same currency as price`, path: [k, 'currency'] })
    }
    if (extra && !l.price) ctx.addIssue({ code: 'custom', message: `${k} needs a price in the same currency`, path: [k] })
  }
  if (l.price && l.price_on_request) ctx.addIssue({ code: 'custom', message: 'Send price or price_on_request, not both', path: ['price_on_request'] })
}

type ListingInputShape = z.output<z.ZodObject<typeof listingFields>>

/** POST /v1/listings body (and each new item in a bulk import). */
export const listingInputSchema = z.object(listingFields).strict()
  .superRefine((l, ctx) => {
    crossChecks(l, ctx)
    if (l.vertical === 'property' && !l.property) ctx.addIssue({ code: 'custom', message: 'A property listing needs a property block', path: ['property'] })
    if (l.vertical === 'vehicle' && !l.vehicle) ctx.addIssue({ code: 'custom', message: 'A vehicle listing needs a vehicle block', path: ['vehicle'] })
  })

export type ListingInput = z.output<typeof listingInputSchema>

/**
 * PATCH body: any partner-owned field. Defaults are NOT applied (a PATCH
 * without availability must not reset it). external_id and vertical are
 * fixed after create, and Viewora-owned fields are refused before this
 * schema runs (see checkPatchOwnership).
 */
export const listingPatchSchema = z.object({
  agent_external_id: listingFields.agent_external_id,
  branch: branchSchema.optional(),
  transaction: z.enum(TRANSACTIONS).optional(),
  title: text(120).optional(),
  description: plainText(2000).nullable().optional(),
  price: priceSchema.nullable().optional(),
  price_on_request: z.boolean().optional(),
  deposit: extraChargeSchema.nullable().optional(),
  service_charge: extraChargeSchema.nullable().optional(),
  availability: z.enum(AVAILABILITY).optional(),
  available_from: z.iso.date().nullable().optional(),
  location: locationSchema.optional(),
  property: propertyBlockSchema.optional(),
  vehicle: vehicleBlockSchema.optional(),
  media: z.array(mediaItemSchema).max(60).optional(),
  partner_updated_at: z.iso.datetime({ offset: true }).optional(),
  publish: z.boolean().optional(),
}).strict()

export type ListingPatch = z.output<typeof listingPatchSchema>

/** Applies a PATCH to the stored listing and re-checks the whole result. */
export function mergePatch(stored: ListingInput, patch: ListingPatch):
  { ok: true; listing: ListingInput } | { ok: false; error: z.ZodError } {
  const merged: Record<string, unknown> = { ...stored }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v === null) delete merged[k]
    else merged[k] = v
  }
  const r = listingInputSchema.safeParse(merged)
  return r.success ? { ok: true, listing: r.data } : { ok: false, error: r.error }
}

// ── Who owns each field ──────────────────────────────────────────────────────
export type Owner = 'partner' | 'viewora'

/** Every top-level field of a listing as the API shows it, and its owner. */
export const FIELD_OWNER: Record<string, Owner> = {
  external_id: 'partner', agent_external_id: 'partner', branch: 'partner', vertical: 'partner',
  transaction: 'partner', title: 'partner', description: 'partner', price: 'partner', price_on_request: 'partner',
  deposit: 'partner', service_charge: 'partner', availability: 'partner', available_from: 'partner',
  location: 'partner', property: 'partner', vehicle: 'partner', media: 'partner',
  partner_updated_at: 'partner', publish: 'partner',

  id: 'viewora', version: 'viewora', slug: 'viewora', publication_status: 'viewora', moderation: 'viewora',
  badges: 'viewora', urls: 'viewora', tours: 'viewora', published_at: 'viewora', expires_at: 'viewora',
  archived_at: 'viewora', restore_until: 'viewora', created_at: 'viewora', updated_at: 'viewora',
}

/** Partner fields that cannot change after the listing is created. */
export const IMMUTABLE_AFTER_CREATE = ['external_id', 'vertical'] as const

export type OwnershipResult =
  | { ok: true }
  | { ok: false; status: 409; code: 'LISTING_OWNED_BY_VIEWORA' | 'FIELD_OWNED_BY_OTHER' | 'FIELD_IMMUTABLE'; fields: string[]; message: string }

/**
 * Runs before the PATCH schema, on the raw body keys, so a partner sending
 * a Viewora-owned field gets a clear 409 instead of a generic validation error.
 * `listingOrigin` is where the listing was created: one made by an agent in
 * the Viewora app is Viewora-owned until the agent approves a claim.
 */
export function checkPatchOwnership(body: unknown, listingOrigin: 'api' | 'app'): OwnershipResult {
  if (listingOrigin !== 'api') {
    return { ok: false, status: 409, code: 'LISTING_OWNED_BY_VIEWORA', fields: [],
      message: 'This listing was created in Viewora. Ask the agent to approve a claim before updating it.' }
  }
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : []
  const immutable = keys.filter(k => (IMMUTABLE_AFTER_CREATE as readonly string[]).includes(k))
  if (immutable.length) {
    return { ok: false, status: 409, code: 'FIELD_IMMUTABLE', fields: immutable,
      message: `${immutable.join(', ')} cannot change after a listing is created. Withdraw it and create a new one.` }
  }
  const viewora = keys.filter(k => FIELD_OWNER[k] === 'viewora')
  if (viewora.length) {
    return { ok: false, status: 409, code: 'FIELD_OWNED_BY_OTHER', fields: viewora,
      message: `${viewora.join(', ')} ${viewora.length === 1 ? 'is' : 'are'} set by Viewora and cannot be changed through the API.` }
  }
  return { ok: true }
}

// ── Publishing requirements ──────────────────────────────────────────────────
export type MediaCounts = { photo: number; panorama: number; tour: number; car_exterior: number }

/** Minimum media to publish. Starting values; tune once real listings arrive. */
export const PUBLISH_MEDIA_MINIMUM = {
  property: { photos: 3, orImmersive: 1 },  // 3 photos, or 1 panorama or tour
  vehicle: { photos: 4 },                    // 4 photos (ordinary or car_exterior)
} as const

export type Blocker = { code: string; field: string; message: string }

/** Why this listing cannot be published yet; an empty list means it can. */
export function publishBlockers(l: ListingInput, media: MediaCounts): Blocker[] {
  const out: Blocker[] = []
  const need = (field: string, message: string) => out.push({ code: 'MISSING_REQUIRED_FIELD', field, message })

  if (!l.price && !l.price_on_request) need('price', 'Add a price, or set price_on_request')
  if (!l.location) need('location', 'Add the county and area')

  if (l.vertical === 'property') {
    const p = l.property
    if (p && !NON_RESIDENTIAL_TYPES.includes(p.property_type) && p.bedrooms === undefined) {
      need('property.bedrooms', 'Add the number of bedrooms (0 for a bedsitter or studio)')
    }
    const m = PUBLISH_MEDIA_MINIMUM.property
    if (media.photo < m.photos && media.panorama + media.tour < m.orImmersive) {
      out.push({ code: 'NOT_ENOUGH_MEDIA', field: 'media',
        message: `Add at least ${m.photos} photos, or a 360° photo or tour` })
    }
  } else {
    const v = l.vehicle
    if (v && v.mileage_km === undefined) need('vehicle.mileage_km', 'Add the mileage in km')
    if (v && !v.transmission) need('vehicle.transmission', 'Add the transmission')
    if (v && !v.fuel_type) need('vehicle.fuel_type', 'Add the fuel type')
    if (!l.price) need('price', 'Vehicle listings need a price')
    const m = PUBLISH_MEDIA_MINIMUM.vehicle
    if (media.photo + media.car_exterior < m.photos) {
      out.push({ code: 'NOT_ENOUGH_MEDIA', field: 'media', message: `Add at least ${m.photos} photos of the vehicle` })
    }
  }
  return out
}

// ── Rules every write follows ────────────────────────────────────────────────
/** True when the incoming update is older than the one already stored (retries arriving out of order). */
export function isStaleUpdate(storedPartnerUpdatedAt: string | null | undefined, incoming: string | null | undefined): boolean {
  if (!storedPartnerUpdatedAt || !incoming) return false
  return Date.parse(incoming) < Date.parse(storedPartnerUpdatedAt)
}

/** Reads an If-Match header: 3, "3" or W/"3". Returns null when absent or malformed. */
export function parseIfMatch(header: unknown): number | null {
  if (typeof header !== 'string') return null
  const m = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header)
  return m ? Number(m[1]) : null
}

/** Starting thresholds for holding a price change for review. Not prices: kept here, tunable. */
export const PRICE_CHANGE_REVIEW = { maxDropPercent: 30, maxChangesPer24h: 3 } as const

/**
 * A price change is risky when it drops by more than 30%, the currency
 * changes, or the price changed more than 3 times in 24 hours (bait pricing).
 * Integer maths only: drop > 30% ⇔ (old − new) × 100 > old × 30.
 */
export function isRiskyPriceChange(
  before: { amount: number; currency: Currency } | null | undefined,
  after: { amount: number; currency: Currency } | null | undefined,
  changesInLast24h = 0,
): boolean {
  if (!before || !after) return false
  if (before.currency !== after.currency) return true
  if (changesInLast24h >= PRICE_CHANGE_REVIEW.maxChangesPer24h) return true
  const drop = before.amount - after.amount
  return drop > 0 && drop * 100 > before.amount * PRICE_CHANGE_REVIEW.maxDropPercent
}

// ── Vehicle identity ─────────────────────────────────────────────────────────
/** Normalises a VIN or chassis number before hashing: upper case, no spaces or dashes. */
export function normaliseVehicleId(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '')
}

/** SHA-256 of the normalised id, stored as vin_hash / chassis_hash for duplicate checks. */
export function hashVehicleId(raw: string): string {
  return createHash('sha256').update(normaliseVehicleId(raw)).digest('hex')
}

// ── Mapping onto the existing tour (properties row) ──────────────────────────
export type SpaceType = 'residential' | 'commercial' | 'land' | 'automotive'

/** Fields accepted by the existing /spaces create and update routes. */
export type SpaceFacts = {
  title: string
  space_type: SpaceType
  description?: string | null
  location_text?: string | null
  price_kes: number | null
  listing_status: 'available' | 'sold' | 'rented' | null
  transaction_type: 'sale' | 'rent'
  price_period: 'day' | 'week' | 'month' | 'year' | null
  bedrooms?: number | null
  bathrooms?: number | null
  area_sqm?: number | null
  land_acres?: number | null
  amenities?: string[] | null
  vehicle_year?: number | null
  vehicle_mileage_km?: number | null
  vehicle_transmission?: 'manual' | 'automatic' | null
  vehicle_fuel_type?: 'petrol' | 'diesel' | 'electric' | 'hybrid' | null
}

/** Fields accepted by the existing car identity route (carTour.ts). */
export type CarIdentity = { vin?: string | null; make: string; model: string; trim?: string | null }

export function spaceTypeFor(l: Pick<ListingInput, 'vertical' | 'property'>): SpaceType {
  if (l.vertical === 'vehicle') return 'automotive'
  const t = l.property?.property_type
  if (t === 'land') return 'land'
  if (t && COMMERCIAL_TYPES.includes(t)) return 'commercial'
  return 'residential'
}

/**
 * The tour row keeps showing the listing on existing pages. It only knows
 * KES, and available/sold/rented, so:
 *   - a USD price leaves price_kes empty (api_listing_state keeps the real price),
 *   - reserved shows as available (the listing page adds the Reserved label from api_listing_state),
 *   - withdrawn clears listing_status (the tour is unpublished instead).
 */
export function toSpaceFacts(l: ListingInput): SpaceFacts {
  const facts: SpaceFacts = {
    title: l.title,
    space_type: spaceTypeFor(l),
    description: l.description ?? null,
    location_text: l.location ? [l.location.estate, l.location.area, l.location.county].filter(Boolean).join(', ').slice(0, 200) : null,
    price_kes: l.price?.currency === 'KES' && l.price.amount > 0 ? l.price.amount : null,
    listing_status: l.availability === 'withdrawn' ? null : l.availability === 'reserved' ? 'available' : l.availability,
    transaction_type: l.transaction === 'sale' ? 'sale' : 'rent',
    price_period: l.price && l.price.period !== 'once' ? l.price.period : null,
  }
  if (l.property) {
    facts.bedrooms = l.property.bedrooms ?? null
    facts.bathrooms = l.property.bathrooms ?? null
    facts.area_sqm = l.property.floor_area_sqm ?? null
    facts.land_acres = l.property.plot_size_acres ?? null
    facts.amenities = l.property.amenities ?? null
  }
  if (l.vehicle) {
    facts.vehicle_year = l.vehicle.year
    facts.vehicle_mileage_km = l.vehicle.mileage_km ?? null
    facts.vehicle_transmission = l.vehicle.transmission ?? null
    facts.vehicle_fuel_type = l.vehicle.fuel_type ?? null
  }
  return facts
}

export function toCarIdentity(l: ListingInput): CarIdentity | null {
  if (!l.vehicle) return null
  return { vin: l.vehicle.vin ?? null, make: l.vehicle.make, model: l.vehicle.model, trim: l.vehicle.variant ?? null }
}

/** The api_listing_state columns for a listing (partner_id and mode are set by the database trigger). */
export function toStateRow(l: ListingInput, tourRefId: string, origin: 'api' | 'app' | 'admin' | 'system' = 'api') {
  const vertical = l.vertical === 'property' ? l.property : l.vehicle
  const { vin, chassis_no, ...vehicleRest } = l.vehicle ?? ({} as Record<string, unknown>)
  return {
    tour_ref_id: tourRefId,
    vertical: l.vertical,
    transaction: l.transaction,
    availability: l.availability,
    available_from: l.available_from ?? null,
    price_amount: l.price?.amount ?? null,
    // The schema refuses a deposit or service charge without a price, so price sets the currency.
    price_currency: l.price?.currency ?? null,
    price_period: l.price?.period ?? null,
    price_negotiable: l.price?.negotiable ?? false,
    price_on_request: l.price_on_request ?? false,
    price_vat_inclusive: l.price?.vat_inclusive ?? null,
    deposit_amount: l.deposit?.amount ?? null,
    service_charge_amount: l.service_charge?.amount ?? null,
    service_charge_period: l.service_charge?.period ?? null,
    location_county: l.location?.county ?? null,
    location_area: l.location?.area ?? null,
    location_estate: l.location?.estate ?? null,
    location_address_line: l.location?.address_line ?? null,
    location_lat: l.location?.lat ?? null,
    location_lng: l.location?.lng ?? null,
    location_display_precision: l.location?.display_precision ?? 'approx_500m',
    branch_external_id: l.branch?.external_id ?? null,
    branch_name: l.branch?.name ?? null,
    branch_town: l.branch?.town ?? null,
    // The VIN and chassis number are kept only as hashes here; the tour row
    // holds the VIN the existing car editor already shows.
    details: l.vertical === 'vehicle' ? vehicleRest : (vertical ?? {}),
    vin_hash: typeof vin === 'string' ? hashVehicleId(vin) : null,
    chassis_hash: typeof chassis_no === 'string' ? hashVehicleId(chassis_no) : null,
    partner_updated_at: l.partner_updated_at ?? null,
    change_origin: origin,
  }
}
