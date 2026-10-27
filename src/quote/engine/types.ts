// Quote engine types. Money is always an integer: whole KES, or USD cents
// once a result is converted. Percentages are basis points (1600 = 16%).

export type RateCategory =
  | 'base'        // price of the job itself, by industry and size
  | 'addon'       // optional extras (video, reel, photos, extra scenes...)
  | 'uplift'      // percentage added to the base (for-sale listing, night shoot)
  | 'discount'    // percentage off (packs, same building, branches)
  | 'travel'      // travel zones
  | 'hosting'     // yearly hosting renewal after the included months
  | 'plan_cap'    // software plan scene caps per tour
  | 'minimum'     // minimum job price per sector

export type RateUnit = 'job' | 'scene' | 'unit' | 'floor' | 'visit' | 'bp' | 'scenes'

export interface RateTier {
  min: number     // tier applies when the count is at least this
  amount: number
}

export interface RateItem {
  key: string
  category: RateCategory
  label: string
  industry?: string
  unit: RateUnit
  low: number | null      // null means "custom": no published price
  high: number | null     // equals low for a fixed price; null for "from X"
  use: 'low' | 'high'     // which end of a range the engine uses
  custom?: boolean        // staff must quote this, even if a "from" price exists
  scenes?: number         // scenes included in a base package
  tiers?: RateTier[]      // volume pricing: all units take the highest tier reached
  meta?: Record<string, unknown>
}

export interface RateSettings {
  vat: { enabled: boolean; rateBp: number }
  discountCapBp: number
  depositBp: number
  usdKesRate: number            // KES per USD, buffer included
  quoteValidityDays: number
  includedHostingMonths: number
  origin: { lat: number; lng: number }  // travel distances are measured from here
}

export interface RateTable {
  id: string
  version: number
  effectiveFrom: string
  settings: RateSettings
  items: Record<string, RateItem>
}

// ── Industry modules (config, not code) ─────────────────────────────────────

export type ClientType = 'owner' | 'agent' | 'developer' | 'manager'
export type ResultMode = 'instant' | 'range' | 'custom'

export interface ChoiceOption {
  value: string
  label: string
  rateKey?: string        // base item this option selects
}

export interface Condition {
  question: string
  in: string[]
}

export interface Question {
  id: string
  type: 'choice' | 'number' | 'text' | 'boolean'
  label: string
  help?: string
  options?: ChoiceOption[]
  min?: number
  max?: number
  default?: string | number | boolean
  required?: boolean
  drivesPrice?: boolean
  showIf?: Condition
  clientTypes?: ClientType[]   // only asked of these client types
}

export interface LadderStep {
  min: number              // count (or unit position) at which this step starts
  rateKey: string          // discount item
}

export type DiscountRule =
  // Whole-order discount chosen by a count: agent packs, lodge groups.
  | { rule: 'pack'; question: string; ladder: LadderStep[] }
  // Per-unit ladder: unit 1 pays full price, later units get the step they fall in.
  | { rule: 'per_unit'; question: string; ladder: LadderStep[] }

export interface ModulePricing {
  sector: 'home' | 'business'
  // Base price: the first listed question whose chosen option has a rateKey.
  base?: { from: string[] }
  // Or a price per scene, for industries without a package (Other).
  perScene?: { question: string; rateKey: string }
  // Multiplies the base, e.g. number of listings in an agent pack.
  quantity?: { question: string }
  perUnit?: Array<{ question: string; rateKey: string; when?: Condition }>
  uplifts?: Array<{ rateKey: string; when: Condition }>
  discounts?: DiscountRule[]
  addons: string[]
  premiumAddons: string[]
  hostingKey: string
}

export interface IndustryModule {
  key: string
  version: number
  label: string
  enabled: boolean
  resultMode: ResultMode
  flagNewIndustry?: boolean
  questions: Question[]
  pricing: ModulePricing
}

// ── Engine input and output ─────────────────────────────────────────────────

export interface LocationAnswer {
  zone?: string
  town?: string
  lat?: number
  lng?: number
}

export interface Answers {
  clientType?: ClientType
  details: Record<string, string | number | boolean | undefined>
  addons?: Record<string, number>   // rate key → quantity
  location?: LocationAnswer
}

export interface PriceContext {
  currency?: 'KES' | 'USD'
  vat?: boolean               // overrides settings.vat.enabled
  plan?: string               // client's software plan slug, when known
  // Only an admin may lift the discount cap, and a reason is required.
  discountOverride?: { capBp: number; reason: string; byRole: 'admin' | 'sales' | 'viewer' }
}

export type LineKind = 'base' | 'per_unit' | 'uplift' | 'addon' | 'discount' | 'minimum' | 'travel'

export interface Line {
  key: string
  kind: LineKind
  label: string
  qty: number
  unit: number
  amount: number
  tbc?: boolean             // price confirmed by staff (far travel)
  note?: string
}

export type Tier = 'essential' | 'standard' | 'premium' | 'estimate' | 'draft'

export interface PriceOption {
  tier: Tier
  lines: Line[]
  subtotal: number          // before discount
  discount: number          // positive amount taken off
  discountBp: number
  net: number               // after discount, minimum and travel, before VAT
  vat: number
  total: number
  totalHigh?: number        // range mode: top of the estimate
  deposit: number
}

export interface Warning {
  code: string              // UI maps codes to text through the strings file
  data?: Record<string, unknown>
}

export interface PlanCheck {
  scenes: number | null
  plan?: string
  cap?: number
  exceeds: boolean
  smallestFit: string | null
}

export interface PriceResult {
  mode: ResultMode
  moduleKey: string
  moduleVersion: number
  rateTableId: string
  rateTableVersion: number
  currency: 'KES' | 'USD'
  fxRate?: number
  vat: { charged: boolean; rateBp: number }
  options: PriceOption[]
  missing: string[]
  warnings: Warning[]
  planCheck: PlanCheck
  travelZone: string | null
  hosting: { includedMonths: number; renewal: number | null }
  flags: string[]
}
