// Answers as staff read them: the module's own question and option wording.

import { modules } from './modules/index.js'
import { CLIENT_TYPE_LABELS, industryLabel } from './industries.js'

const TIMING_LABELS: Record<string, string> = { this_week: 'This week', this_month: 'This month', planning: 'Just planning' }

export function answersView(request: Record<string, any>, itemLabel: (key: string) => string = k => k): Array<{ label: string; value: string }> {
  const module = request.moduleKey ? modules[request.moduleKey] : undefined
  const a = request.answers ?? {}
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Industry', value: industryLabel(request.moduleKey, request.flags ?? [], module?.label) },
    { label: 'Who they are', value: request.clientType ? CLIENT_TYPE_LABELS[request.clientType] ?? request.clientType : 'Not given' },
  ]
  for (const q of module?.questions ?? []) {
    const v = a.details?.[q.id]
    if (v === undefined || v === null || v === '') continue
    const option = q.options?.find(o => o.value === String(v))
    rows.push({ label: q.label, value: option?.label ?? (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)) })
  }
  const addons = Object.entries(a.addons ?? {}) as Array<[string, number]>
  if (addons.length) rows.push({ label: 'Extras', value: addons.map(([k, n]) => (n > 1 ? `${itemLabel(k)} × ${n}` : itemLabel(k))).join(', ') })
  const loc = a.location
  if (loc) {
    const parts = [loc.town, loc.lat !== undefined && loc.lng !== undefined ? `pin ${loc.lat}, ${loc.lng}` : null].filter(Boolean)
    rows.push({ label: 'Where', value: parts.join(' · ') })
  }
  if (a.timing) rows.push({ label: 'When', value: TIMING_LABELS[a.timing] ?? a.timing })
  if (a.note) rows.push({ label: 'Note', value: a.note })
  return rows
}

