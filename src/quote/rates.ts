// Rate table editor helpers: which industries use a price, what changed
// between two versions, and example prices before and after, so staff see
// the effect of an edit before publishing it.

import { price } from './engine/price.js'
import type { Answers, IndustryModule, RateItem, RateSettings, RateTable } from './engine/types.js'

// Rate keys each module's pricing reads (travel, minimums and plan caps are shared)
export function itemUsage(mods: Record<string, IndustryModule>, table: RateTable): Record<string, string[]> {
  const usage: Record<string, Set<string>> = {}
  const add = (key: string | undefined, module: string) => { if (key) (usage[key] ??= new Set()).add(module) }
  for (const m of Object.values(mods)) {
    const p = m.pricing
    for (const q of m.questions) for (const o of q.options ?? []) add(o.rateKey, m.key)
    add(p.perScene?.rateKey, m.key)
    for (const u of p.perUnit ?? []) add(u.rateKey, m.key)
    for (const u of p.uplifts ?? []) add(u.rateKey, m.key)
    for (const d of p.discounts ?? []) for (const step of d.ladder) add(step.rateKey, m.key)
    for (const k of [...p.addons, ...p.premiumAddons, p.hostingKey, `min_${p.sector}`]) add(k, m.key)
  }
  const out: Record<string, string[]> = {}
  for (const item of Object.values(table.items)) {
    out[item.key] = usage[item.key] ? [...usage[item.key]].sort()
      : ['travel', 'plan_cap'].includes(item.category) ? ['all'] : []
  }
  return out
}

export interface ItemChange {
  key: string
  label: string
  category: string
  before: Pick<RateItem, 'label' | 'low' | 'high' | 'use'> | null
  after: Pick<RateItem, 'label' | 'low' | 'high' | 'use'> | null
  modules: string[]
}

const pick = (i: RateItem) => ({ label: i.label, low: i.low, high: i.high, use: i.use })

export function diffTables(from: RateTable, to: RateTable, usage: Record<string, string[]>): { items: ItemChange[]; settings: Array<{ field: string; before: unknown; after: unknown }> } {
  const items: ItemChange[] = []
  for (const key of new Set([...Object.keys(from.items), ...Object.keys(to.items)])) {
    const a = from.items[key], b = to.items[key]
    const before = a ? pick(a) : null, after = b ? pick(b) : null
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      items.push({ key, label: (b ?? a).label, category: (b ?? a).category, before, after, modules: usage[key] ?? [] })
    }
  }
  const settings: Array<{ field: string; before: unknown; after: unknown }> = []
  const flat = (s: RateSettings) => ({
    'vat.enabled': s.vat.enabled, 'vat.rateBp': s.vat.rateBp, discountCapBp: s.discountCapBp, depositBp: s.depositBp,
    usdKesRate: s.usdKesRate, quoteValidityDays: s.quoteValidityDays, includedHostingMonths: s.includedHostingMonths,
  })
  const fa = flat(from.settings), fb = flat(to.settings)
  for (const field of Object.keys(fa) as Array<keyof typeof fa>) {
    if (fa[field] !== fb[field]) settings.push({ field, before: fa[field], after: fb[field] })
  }
  return { items: items.sort((x, y) => x.category.localeCompare(y.category) || x.key.localeCompare(y.key)), settings }
}

// A typical visitor for each size a module prices: defaults for every
// other question, in Nairobi, no extras.
export function sampleAnswers(m: IndustryModule): Array<{ label: string; answers: Answers }> {
  const details: Answers['details'] = {}
  for (const q of m.questions) {
    if (q.default !== undefined) details[q.id] = q.default
    else if (q.type === 'choice' && q.options?.length) details[q.id] = q.options[0].value
    else if (q.type === 'number') details[q.id] = Math.max(1, q.min ?? 1)
    else if (q.type === 'boolean') details[q.id] = false
  }
  const clientType = m.questions.find(q => q.clientTypes)?.clientTypes?.[0] ?? 'owner'
  const sizeQ = m.pricing.base?.from.map(id => m.questions.find(q => q.id === id)).find(q => q?.options?.some(o => o.rateKey))
  const base = { clientType, details, location: { town: 'Nairobi' } } as Answers
  if (!sizeQ) return [{ label: m.label, answers: base }]
  return sizeQ.options!.filter(o => o.rateKey).map(o => ({
    label: `${m.label}: ${o.label}`,
    answers: { ...base, details: { ...details, [sizeQ.id]: o.value } },
  }))
}

export interface Example { module: string; label: string; before: number | null; after: number | null }

// Standard price (or the single option) for each sample, on both tables;
// null when the visitor would see "we'll reply" (priced by hand)
export function examplePrices(mods: Record<string, IndustryModule>, from: RateTable, to: RateTable): Example[] {
  const standard = (m: IndustryModule, a: Answers, t: RateTable) => {
    const r = price(m, a, t)
    if (r.mode === 'custom') return null
    return (r.options.find(o => o.tier === 'standard') ?? r.options[0])?.total ?? null
  }
  const out: Example[] = []
  for (const m of Object.values(mods).filter(x => x.enabled)) {
    for (const s of sampleAnswers(m)) {
      const before = standard(m, s.answers, from), after = standard(m, s.answers, to)
      if (before !== after) out.push({ module: m.key, label: s.label, before, after })
    }
  }
  return out
}
