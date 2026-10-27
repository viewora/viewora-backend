// The quote desk: what staff do to a quote between the form and the client.
// Pure functions only (no database or clock unless passed in), so the rules
// for totals, discount limits and versions are tested on their own and both
// stores (memory and Supabase) apply exactly the same ones.

import type { LineKind, PriceResult, ResultMode, Tier, Warning } from './engine/types.js'

export type QuoteStatus = 'draft' | 'needs_approval' | 'sent' | 'viewed' | 'accepted' | 'expired' | 'lost' | 'superseded'

export interface DocLine {
  key: string | null        // rate item key; null for a line staff typed
  kind: LineKind
  label: string
  qty: number
  unit: number
  amount: number            // always qty × unit, recomputed here
  tbc: boolean              // price still to be confirmed (far travel)
  note: string | null
}

export interface DocOption {
  tier: Tier
  selected: boolean
  lines: DocLine[]
  subtotal: number
  discount: number
  discountBp: number
  net: number
  vat: number
  total: number
  deposit: number
}

// What the engine priced, kept so a staff edit can be compared with it:
// discounts the rate table gave are not counted against a person's limit.
export interface Baseline {
  discountBp: number
  units: Record<string, number>
}

export interface QuoteDoc {
  id: string | null
  requestId: string
  leadId: string | null
  version: number
  supersedesId: string | null
  status: QuoteStatus
  mode: ResultMode
  currency: 'KES' | 'USD'
  vatCharged: boolean
  vatRateBp: number
  depositBp: number
  validUntil: string | null          // YYYY-MM-DD, Nairobi date
  discountReason: string | null
  discountApprovedBy: string | null
  clientNote: string | null          // shown to the client on the quote page and PDF
  rateTableId: string
  rateTableVersion: number
  createdBy: string | null           // null when the form made it
  createdAt: string | null
  sentAt: string | null
  viewedAt: string | null
  baseline: Partial<Record<Tier, Baseline>>
  warnings: Warning[]
  options: DocOption[]
}

export const EDITABLE: QuoteStatus[] = ['draft', 'needs_approval']
export const SENDABLE: QuoteStatus[] = ['draft', 'sent', 'viewed']
// Editing one of these makes a new version; the client's copy never changes
export const VERSION_ON_EDIT: QuoteStatus[] = ['sent', 'viewed']

const ofBp = (amount: number, bp: number) => Math.round((amount * bp) / 10000)
const PRICED_KINDS: LineKind[] = ['base', 'per_unit', 'uplift', 'addon']

// Same arithmetic as the engine's assemble(), over lines staff may have edited
export function recalcOption(option: Omit<DocOption, 'subtotal' | 'discount' | 'discountBp' | 'net' | 'vat' | 'total' | 'deposit'>, vatBp: number, depositBp: number): DocOption {
  const lines = option.lines.map(l => ({ ...l, amount: l.qty * l.unit }))
  const subtotal = lines.filter(l => PRICED_KINDS.includes(l.kind)).reduce((s, l) => s + l.amount, 0)
  const discount = -lines.filter(l => l.kind === 'discount').reduce((s, l) => s + l.amount, 0)
  const net = lines.reduce((s, l) => s + l.amount, 0)
  const vat = ofBp(net, vatBp)
  const total = net + vat
  return {
    tier: option.tier, selected: option.selected, lines, subtotal, discount,
    discountBp: subtotal ? Math.round((discount * 10000) / subtotal) : 0,
    net, vat, total, deposit: ofBp(total, depositBp),
  }
}

export function recalc(doc: QuoteDoc): QuoteDoc {
  const vatBp = doc.vatCharged ? doc.vatRateBp : 0
  let options = doc.options.map(o => recalcOption(o, vatBp, doc.depositBp))
  // Exactly one option is the one we recommend
  const chosen = options.findIndex(o => o.selected)
  const pick = chosen >= 0 ? chosen : Math.max(0, options.findIndex(o => o.tier === 'standard'))
  options = options.map((o, i) => ({ ...o, selected: i === pick }))
  return { ...doc, options }
}

export function baselineOf(result: Pick<PriceResult, 'options'>): Partial<Record<Tier, Baseline>> {
  const out: Partial<Record<Tier, Baseline>> = {}
  for (const o of result.options) {
    const units: Record<string, number> = {}
    for (const l of o.lines) if (l.kind !== 'discount' && l.kind !== 'minimum') units[l.key] = l.unit
    out[o.tier] = { discountBp: o.discountBp, units }
  }
  return out
}

// A quote as the form saved it, before staff touch it
export function docFromEngine(result: PriceResult, opts: {
  requestId: string; leadId: string | null; version: number; depositBp: number; validUntil: string | null
  status: QuoteStatus; createdBy?: string | null
}): QuoteDoc {
  return recalc({
    id: null, requestId: opts.requestId, leadId: opts.leadId, version: opts.version, supersedesId: null,
    status: opts.status, mode: result.mode, currency: result.currency,
    vatCharged: result.vat.charged, vatRateBp: result.vat.rateBp, depositBp: opts.depositBp,
    validUntil: opts.validUntil, discountReason: null, discountApprovedBy: null, clientNote: null,
    rateTableId: result.rateTableId, rateTableVersion: result.rateTableVersion,
    createdBy: opts.createdBy ?? null, createdAt: null, sentAt: null, viewedAt: null,
    baseline: baselineOf(result), warnings: result.warnings,
    options: result.options.map(o => ({
      tier: o.tier, selected: o.tier === 'standard' || result.options.length === 1,
      lines: o.lines.map(l => ({ key: l.key, kind: l.kind, label: l.label, qty: l.qty, unit: l.unit, amount: l.amount, tbc: !!l.tbc, note: l.note ?? null })),
      subtotal: 0, discount: 0, discountBp: 0, net: 0, vat: 0, total: 0, deposit: 0,
    })),
  })
}

// Staff confirm the price, so estimates and drafts become a firm Standard option
const STAFF_TIER: Partial<Record<Tier, Tier>> = { estimate: 'standard', draft: 'standard' }

export function firmTiers(doc: QuoteDoc): QuoteDoc {
  const baseline: Partial<Record<Tier, Baseline>> = {}
  for (const [tier, b] of Object.entries(doc.baseline) as Array<[Tier, Baseline]>) {
    const to = STAFF_TIER[tier] ?? tier
    if (!baseline[to] || to === tier) baseline[to] = b
  }
  return { ...doc, baseline, options: doc.options.map(o => ({ ...o, tier: STAFF_TIER[o.tier] ?? o.tier })) }
}

// The next version staff work on, copied from the latest one
export function nextDraft(from: QuoteDoc, opts: { version: number; createdBy: string; validUntil: string; depositBp?: number }): QuoteDoc {
  const firm = firmTiers(structuredClone(from))
  return recalc({
    ...firm,
    id: null, version: opts.version, supersedesId: from.status === 'draft' || from.status === 'needs_approval' ? from.supersedesId : from.id,
    status: 'draft', createdBy: opts.createdBy, createdAt: null, sentAt: null, viewedAt: null,
    discountApprovedBy: null, validUntil: opts.validUntil, depositBp: opts.depositBp ?? from.depositBp,
  })
}

// An empty quote for a lead whose answers can't be priced (they stopped early)
export function blankDraft(opts: {
  requestId: string; leadId: string; version: number; createdBy: string; validUntil: string
  depositBp: number; vatCharged: boolean; vatRateBp: number; rateTableId: string; rateTableVersion: number
}): QuoteDoc {
  return recalc({
    id: null, requestId: opts.requestId, leadId: opts.leadId, version: opts.version, supersedesId: null,
    status: 'draft', mode: 'custom', currency: 'KES', vatCharged: opts.vatCharged, vatRateBp: opts.vatRateBp,
    depositBp: opts.depositBp, validUntil: opts.validUntil, discountReason: null, discountApprovedBy: null,
    clientNote: null, rateTableId: opts.rateTableId, rateTableVersion: opts.rateTableVersion,
    createdBy: opts.createdBy, createdAt: null, sentAt: null, viewedAt: null, baseline: {}, warnings: [],
    options: [{ tier: 'standard', selected: true, lines: [], subtotal: 0, discount: 0, discountBp: 0, net: 0, vat: 0, total: 0, deposit: 0 }],
  })
}

// ── Rules for a staff save ──────────────────────────────────────────────────

export type StaffRole = 'admin' | 'sales' | 'viewer'

export interface CheckContext {
  role: StaffRole
  discountLimitBp: number      // this person's own limit
  discountCapBp: number        // the rate table's hard cap
  // Rate-table price for a key the engine didn't price (a line staff added)
  listPrice?: (key: string) => number | null
}

export interface CheckResult {
  errors: Array<{ code: string; data?: Record<string, unknown> }>
  needsApproval: boolean
  approvalReasons: Array<{ code: string; data?: Record<string, unknown> }>
  staffDiscountBp: number      // largest discount beyond what the rate table gave
}

export function checkDoc(doc: QuoteDoc, ctx: CheckContext): CheckResult {
  const errors: CheckResult['errors'] = []
  const approvalReasons: CheckResult['approvalReasons'] = []
  let staffDiscountBp = 0
  let totalDiscountBp = 0

  if (!doc.options.length) errors.push({ code: 'no_options' })
  for (const o of doc.options) {
    const base = doc.baseline[o.tier]
    staffDiscountBp = Math.max(staffDiscountBp, o.discountBp - (base?.discountBp ?? 0))
    totalDiscountBp = Math.max(totalDiscountBp, o.discountBp)
    if (o.total < 0) errors.push({ code: 'negative_total', data: { tier: o.tier } })
    for (const l of o.lines) {
      if (l.kind === 'discount' ? l.unit > 0 : l.unit < 0) errors.push({ code: 'line_sign', data: { tier: o.tier, label: l.label } })
      // Lowering a rate-table price is a discount in disguise: admins only
      const listed = l.key ? base?.units[l.key] ?? ctx.listPrice?.(l.key) ?? undefined : undefined
      if (ctx.role !== 'admin' && listed !== undefined && l.kind !== 'discount' && l.unit < listed) {
        errors.push({ code: 'price_cut_needs_admin', data: { tier: o.tier, label: l.label, listed } })
      }
    }
  }
  staffDiscountBp = Math.max(0, staffDiscountBp)
  if (staffDiscountBp > 0 && !doc.discountReason?.trim()) errors.push({ code: 'discount_reason_required' })

  if (ctx.role !== 'admin') {
    if (totalDiscountBp > ctx.discountCapBp) approvalReasons.push({ code: 'over_cap', data: { capBp: ctx.discountCapBp, discountBp: totalDiscountBp } })
    if (staffDiscountBp > ctx.discountLimitBp) approvalReasons.push({ code: 'over_limit', data: { limitBp: ctx.discountLimitBp, discountBp: staffDiscountBp } })
  }
  return { errors, needsApproval: approvalReasons.length > 0, approvalReasons, staffDiscountBp }
}

// Why a quote can't be sent right now, or null if it can
export function sendBlocker(doc: QuoteDoc, today: string, optedOut: boolean): string | null {
  if (optedOut) return 'opted_out'
  if (doc.status === 'needs_approval') return 'needs_approval'
  if (!SENDABLE.includes(doc.status)) return 'locked'
  if (!doc.options.length || doc.options.every(o => !o.lines.length)) return 'no_lines'
  if (doc.options.some(o => o.lines.some(l => l.tbc))) return 'tbc_lines'
  if (doc.validUntil && doc.validUntil < today) return 'validity_past'
  return null
}

// Nairobi calendar date (EAT is UTC+3 all year)
export function nairobiDate(now: Date, addDays = 0): string {
  const d = new Date(now.getTime() + 3 * 3_600_000 + addDays * 86_400_000)
  return d.toISOString().slice(0, 10)
}

// Messages only go out between 07:00 and 21:00 in Nairobi
export function inQuietHours(now: Date): boolean {
  const hour = (now.getUTCHours() + 3) % 24
  return hour < 7 || hour >= 21
}

// The link stops working a while after the price expires, so the client
// still sees an honest "this price has expired" page for a month.
export function linkExpiry(validUntil: string | null, now: Date): string {
  const base = validUntil ? Date.parse(`${validUntil}T21:00:00Z`) : now.getTime()   // end of that day in Nairobi
  return new Date(Math.max(base, now.getTime()) + 30 * 86_400_000).toISOString()
}

// Money as people read it; negatives get a real minus sign
export function formatKes(amount: number, currency: 'KES' | 'USD' = 'KES'): string {
  const abs = Math.abs(amount)
  const text = currency === 'USD'
    ? `USD ${(abs / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `KES ${abs.toLocaleString('en-KE')}`
  return amount < 0 ? `−${text}` : text
}
