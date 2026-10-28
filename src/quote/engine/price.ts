// The pricing engine: answers + rate table + industry module in, priced
// options out. Pure — no database, network or clock — so every price can
// be reproduced from the rate table version a quote was built on.

import type {
  Answers, Condition, IndustryModule, Line, PlanCheck, PriceContext, PriceOption,
  PriceResult, Question, RateItem, RateTable, ResultMode, Tier, Warning,
} from './types.js'
import { resolveZone } from './zones.js'

type End = 'use' | 'low' | 'high'

const ofBp = (amount: number, bp: number) => Math.round((amount * bp) / 10000)

function valueOf(item: RateItem, end: End): number | null {
  const pick = end === 'use' ? item.use : end
  return pick === 'high' ? (item.high ?? item.low) : item.low
}

function tierValue(item: RateItem, count: number, end: End): number | null {
  if (!item.tiers?.length) return valueOf(item, end)
  let amount = valueOf(item, end)
  for (const tier of [...item.tiers].sort((a, b) => a.min - b.min)) {
    if (count >= tier.min) amount = tier.amount
  }
  return amount
}

function matches(cond: Condition, answers: Answers): boolean {
  const value = answers.details[cond.question]
  return value !== undefined && cond.in.includes(String(value))
}

export function isVisible(q: Question, answers: Answers): boolean {
  if (q.clientTypes && (!answers.clientType || !q.clientTypes.includes(answers.clientType))) return false
  return q.showIf ? matches(q.showIf, answers) : true
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}

function numberAnswer(module: IndustryModule, answers: Answers, id: string): number {
  const q = module.questions.find(x => x.id === id)
  if (q && !isVisible(q, answers)) return Number(q.default ?? 0)
  const v = answers.details[id] ?? q?.default
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

export function missingAnswers(module: IndustryModule, answers: Answers): string[] {
  return module.questions
    .filter(q => q.required && isVisible(q, answers) && isEmpty(answers.details[q.id]))
    .map(q => q.id)
}

interface Built {
  lines: Line[]
  scenes: number | null
  custom: boolean
  unresolvedBase: boolean
  travelTbc: boolean
  // The rate card gives a range for the base or a per-unit price, so the
  // visitor sees an estimate, not one end of it presented as the price
  ranged: boolean
  zone: string | null
  warnings: Warning[]
}

function buildLines(
  module: IndustryModule,
  answers: Answers,
  table: RateTable,
  addons: Record<string, number>,
  end: End,
  ctx: PriceContext,
): Built {
  const p = module.pricing
  const items = table.items
  const lines: Line[] = []
  const warnings: Warning[] = []
  let scenes: number | null = null
  let custom = false
  let unresolvedBase = false
  let ranged = false
  let minimumApplies = true
  // A range has two ends; "from X" (no top) is confirmed by staff
  const spread = (item: RateItem) => {
    if (item.custom || item.high === null) custom = true
    else if (item.high !== item.low && !item.tiers) ranged = true
  }

  // Base
  const qty = p.quantity ? Math.max(1, numberAnswer(module, answers, p.quantity.question)) : 1
  if (p.base) {
    let baseItem: RateItem | undefined
    for (const qid of p.base.from) {
      const q = module.questions.find(x => x.id === qid)
      if (!q || !isVisible(q, answers)) continue
      const opt = q.options?.find(o => o.value === String(answers.details[qid]))
      if (opt?.rateKey) { baseItem = items[opt.rateKey]; minimumApplies = !opt.noMinimum; break }
    }
    if (baseItem) {
      const unit = valueOf(baseItem, end)
      if (baseItem.custom || unit === null) custom = true
      spread(baseItem)
      lines.push({ key: baseItem.key, kind: 'base', label: baseItem.label, qty, unit: unit ?? 0, amount: qty * (unit ?? 0) })
      scenes = baseItem.scenes ?? null
    }
  }
  if (p.perScene) {
    const item = items[p.perScene.rateKey]
    const n = numberAnswer(module, answers, p.perScene.question)
    const unit = valueOf(item, end) ?? 0
    if (n === 0) warnings.push({ code: 'scenes_missing' })
    lines.push({ key: item.key, kind: 'base', label: item.label, qty: n, unit, amount: n * unit })
    scenes = n
  }

  // Per-unit items (vehicles, machines)
  for (const pu of p.perUnit ?? []) {
    if (pu.when && !matches(pu.when, answers)) continue
    const count = numberAnswer(module, answers, pu.question)
    if (count === 0) continue
    const item = items[pu.rateKey]
    spread(item)
    const unit = tierValue(item, count, end) ?? 0
    lines.push({ key: item.key, kind: 'per_unit', label: item.label, qty: count, unit, amount: count * unit })
  }
  // Some jobs are priced per unit only (car hire), so either kind counts
  if (!lines.length) unresolvedBase = true

  // Uplifts are a percentage of the base and per-unit lines
  const core = () => lines.filter(l => l.kind === 'base' || l.kind === 'per_unit').reduce((s, l) => s + l.amount, 0)
  const coreAmount = core()
  for (const up of p.uplifts ?? []) {
    if (!matches(up.when, answers)) continue
    const item = items[up.rateKey]
    const amount = ofBp(coreAmount, item.low ?? 0)
    lines.push({ key: item.key, kind: 'uplift', label: item.label, qty: 1, unit: amount, amount })
  }

  // Add-ons: fixed prices first, then percentage add-ons (rush) on top of them
  const allowed = new Set([...p.addons, ...p.premiumAddons])
  const percentAddons: RateItem[] = []
  for (const [key, rawQty] of Object.entries(addons)) {
    const n = Math.max(0, Math.floor(rawQty))
    const item = items[key]
    if (!n || !item || !allowed.has(key)) continue
    if (item.unit === 'bp') { percentAddons.push(item); continue }
    const unit = valueOf(item, end)
    if (unit === null) { warnings.push({ code: 'addon_needs_quote', data: { key } }); continue }
    lines.push({ key, kind: 'addon', label: item.label, qty: n, unit, amount: n * unit })
    if (item.meta?.addsScenes && scenes !== null) scenes += n
  }
  const beforePercent = lines.reduce((s, l) => s + l.amount, 0)
  for (const item of percentAddons) {
    const amount = ofBp(beforePercent, item.low ?? 0)
    lines.push({ key: item.key, kind: 'addon', label: item.label, qty: 1, unit: amount, amount })
  }

  // Discounts apply to the job (base, per-unit, uplifts), not to add-ons.
  // Rules don't stack: the single best rule wins, then the total cap applies.
  const discountable = lines.filter(l => l.kind !== 'addon').reduce((s, l) => s + l.amount, 0)
  let best: Line[] = []
  let bestAmount = 0
  for (const rule of p.discounts ?? []) {
    const candidate: Line[] = []
    const count = numberAnswer(module, answers, rule.question)
    const steps = [...rule.ladder].sort((a, b) => a.min - b.min)
    if (rule.rule === 'pack') {
      const step = steps.filter(s => count >= s.min).pop()
      if (step) {
        const item = items[step.rateKey]
        const amount = ofBp(discountable, item.low ?? 0)
        candidate.push({ key: item.key, kind: 'discount', label: item.label, qty: 1, unit: -amount, amount: -amount })
      }
    } else if (count > 1) {
      // The ladder covers the first `count` of the `qty` units in the order
      const unitPrice = Math.round(discountable / qty)
      const byStep = new Map<string, number>()
      for (let u = 1; u <= Math.min(count, qty); u++) {
        const step = steps.filter(s => u >= s.min).pop()
        if (step) byStep.set(step.rateKey, (byStep.get(step.rateKey) ?? 0) + 1)
      }
      for (const [key, units] of byStep) {
        const item = items[key]
        const per = ofBp(unitPrice, item.low ?? 0)
        candidate.push({ key, kind: 'discount', label: item.label, qty: units, unit: -per, amount: -per * units })
      }
    }
    const amount = -candidate.reduce((s, l) => s + l.amount, 0)
    if (amount > bestAmount) { best = candidate; bestAmount = amount }
  }

  const subtotal = lines.reduce((s, l) => s + l.amount, 0)
  let capBp = table.settings.discountCapBp
  if (ctx.discountOverride) {
    if (ctx.discountOverride.byRole === 'admin' && ctx.discountOverride.reason.trim()) capBp = ctx.discountOverride.capBp
    else warnings.push({ code: 'override_not_allowed' })
  }
  const cap = ofBp(subtotal, capBp)
  if (bestAmount > cap) {
    warnings.push({ code: 'discount_capped', data: { requestedBp: Math.round((bestAmount * 10000) / subtotal), capBp } })
    best = [{ key: 'discount_capped', kind: 'discount', label: best.map(l => l.label).join(' + '), qty: 1, unit: -cap, amount: -cap, note: 'capped' }]
  }
  lines.push(...best)

  // Minimum job price
  const minItem = minimumApplies ? items[`min_${p.sector}`] : undefined
  const jobNet = lines.reduce((s, l) => s + l.amount, 0)
  const minimum = minItem ? valueOf(minItem, end) ?? 0 : 0
  if (minItem && !custom && jobNet < minimum) {
    const gap = minimum - jobNet
    lines.push({ key: minItem.key, kind: 'minimum', label: minItem.label, qty: 1, unit: gap, amount: gap })
  }

  // Travel is always its own line
  const zone = resolveZone(answers.location, table)
  let travelTbc = false
  const zoneItem = zone ? items[zone] : items.travel_unconfirmed
  if (zoneItem) {
    const unit = zoneItem.custom ? null : valueOf(zoneItem, end)
    travelTbc = unit === null
    lines.push({ key: zoneItem.key, kind: 'travel', label: zoneItem.label, qty: 1, unit: unit ?? 0, amount: unit ?? 0, ...(travelTbc ? { tbc: true } : {}) })
    if (!zone) warnings.push({ code: 'location_unresolved' })
    else if (travelTbc) warnings.push({ code: 'travel_far', data: { perDiem: items.travel_per_diem?.low ?? null } })
  }

  return { lines, scenes, custom, unresolvedBase, travelTbc, ranged, zone, warnings }
}

function toUsd(lines: Line[], rate: number): Line[] {
  const c = (kes: number) => Math.round((kes * 100) / rate)
  return lines.map(l => ({ ...l, unit: c(l.unit), amount: c(l.unit) * l.qty }))
}

function assemble(tier: Tier, lines: Line[], vatBp: number, depositBp: number): PriceOption {
  const subtotal = lines.filter(l => ['base', 'per_unit', 'uplift', 'addon'].includes(l.kind)).reduce((s, l) => s + l.amount, 0)
  const discount = -lines.filter(l => l.kind === 'discount').reduce((s, l) => s + l.amount, 0)
  const net = lines.reduce((s, l) => s + l.amount, 0)
  const vat = ofBp(net, vatBp)
  const total = net + vat
  return {
    tier, lines, subtotal, discount,
    discountBp: subtotal ? Math.round((discount * 10000) / subtotal) : 0,
    net, vat, total, deposit: ofBp(total, depositBp),
  }
}

function planCheck(table: RateTable, scenes: number | null, plan?: string): PlanCheck {
  const caps = Object.values(table.items)
    .filter(i => i.category === 'plan_cap' && i.low !== null)
    .sort((a, b) => (a.low as number) - (b.low as number))
  const slug = (i: RateItem) => String(i.meta?.plan ?? i.key)
  const smallestFit = scenes === null ? null : (caps.find(c => (c.low as number) >= scenes) ?? null)
  const planCap = plan ? caps.find(c => slug(c) === plan) : undefined
  return {
    scenes,
    ...(plan ? { plan } : {}),
    ...(planCap ? { cap: planCap.low as number } : {}),
    exceeds: scenes !== null && planCap !== undefined && scenes > (planCap.low as number),
    smallestFit: smallestFit ? slug(smallestFit) : null,
  }
}

export function price(module: IndustryModule, answers: Answers, table: RateTable, ctx: PriceContext = {}): PriceResult {
  const s = table.settings
  const currency = ctx.currency ?? 'KES'
  const vatCharged = ctx.vat ?? s.vat.enabled
  const vatBp = vatCharged ? s.vat.rateBp : 0
  const chosen = answers.addons ?? {}
  const missing = missingAnswers(module, answers)
  const missingDrivers = missing.filter(id => module.questions.find(q => q.id === id)?.drivesPrice)
  const renewalItem = table.items[module.pricing.hostingKey]
  const flags = module.flagNewIndustry ? ['new_industry'] : []

  const finish = (lines: Line[]) => (currency === 'USD' ? toUsd(lines, s.usdKesRate) : lines)

  const standard = buildLines(module, answers, table, chosen, 'use', ctx)
  let mode: ResultMode = module.resultMode
  if (missingDrivers.length || standard.unresolvedBase || standard.custom) mode = 'custom'
  else if (mode === 'instant' && (standard.travelTbc || standard.ranged)) mode = 'range'

  const result = (options: PriceOption[], warnings: Warning[]): PriceResult => ({
    mode,
    moduleKey: module.key,
    moduleVersion: module.version,
    rateTableId: table.id,
    rateTableVersion: table.version,
    currency,
    ...(currency === 'USD' ? { fxRate: s.usdKesRate } : {}),
    vat: { charged: vatCharged, rateBp: s.vat.rateBp },
    options,
    missing,
    warnings,
    planCheck: planCheck(table, standard.scenes, ctx.plan),
    travelZone: standard.zone,
    hosting: { includedMonths: s.includedHostingMonths, renewal: renewalItem ? valueOf(renewalItem, 'use') : null },
    flags,
  })

  if (missingDrivers.length || standard.unresolvedBase) return result([], standard.warnings)

  if (mode === 'custom') {
    // Staff-only draft; the visitor sees "we'll reply"
    return result([assemble('draft', finish(standard.lines), vatBp, s.depositBp)], standard.warnings)
  }

  if (mode === 'range') {
    const low = buildLines(module, answers, table, chosen, 'low', ctx)
    const high = buildLines(module, answers, table, chosen, 'high', ctx)
    const option = assemble('estimate', finish(low.lines), vatBp, s.depositBp)
    option.totalHigh = assemble('estimate', finish(high.lines), vatBp, s.depositBp).total
    return result([option], standard.warnings)
  }

  const premiumAddons = { ...chosen }
  for (const key of module.pricing.premiumAddons) premiumAddons[key] = Math.max(1, premiumAddons[key] ?? 0)
  const essential = buildLines(module, answers, table, {}, 'use', ctx)
  const premium = buildLines(module, answers, table, premiumAddons, 'use', ctx)
  return result([
    assemble('essential', finish(essential.lines), vatBp, s.depositBp),
    assemble('standard', finish(standard.lines), vatBp, s.depositBp),
    assemble('premium', finish(premium.lines), vatBp, s.depositBp),
  ], standard.warnings)
}
