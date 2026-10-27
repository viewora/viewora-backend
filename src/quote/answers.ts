// Validates the answers a visitor sends against the industry module's own
// questions. Unknown keys are dropped, so the stored answers only ever hold
// what the module asks.

import type { IndustryModule } from './engine/types.js'
import { sanitizeLeadText } from '../utils/sanitize.js'

export interface FieldError { field: string; code: 'invalid_option' | 'out_of_range' | 'too_long' | 'not_offered' }

const MAX_TEXT = 500
const MAX_ADDON_QTY = 200

export function cleanDetails(module: IndustryModule, input: Record<string, unknown>) {
  const details: Record<string, string | number | boolean> = {}
  const errors: FieldError[] = []
  for (const q of module.questions) {
    const v = input[q.id]
    if (v === undefined || v === null || v === '') continue
    if (q.type === 'choice') {
      if (q.options?.some(o => o.value === String(v))) details[q.id] = String(v)
      else errors.push({ field: q.id, code: 'invalid_option' })
    } else if (q.type === 'number') {
      const n = Number(v)
      if (!Number.isFinite(n) || n < (q.min ?? 0) || n > (q.max ?? 10_000)) errors.push({ field: q.id, code: 'out_of_range' })
      else details[q.id] = Math.floor(n)
    } else if (q.type === 'boolean') {
      details[q.id] = v === true || v === 'true'
    } else {
      const s = String(v)
      if (s.length > MAX_TEXT) errors.push({ field: q.id, code: 'too_long' })
      else details[q.id] = sanitizeLeadText(s, MAX_TEXT)
    }
  }
  return { details, errors }
}

export function cleanAddons(module: IndustryModule, input: Record<string, unknown>) {
  const offered = new Set([...module.pricing.addons, ...module.pricing.premiumAddons])
  const addons: Record<string, number> = {}
  const errors: FieldError[] = []
  for (const [key, raw] of Object.entries(input)) {
    const n = Math.floor(Number(raw))
    if (!offered.has(key)) { errors.push({ field: key, code: 'not_offered' }); continue }
    if (!Number.isFinite(n) || n < 0 || n > MAX_ADDON_QTY) { errors.push({ field: key, code: 'out_of_range' }); continue }
    if (n > 0) addons[key] = n
  }
  return { addons, errors }
}
