// AI draft for "Something else" requests (Phase 5d). Gemini reads what the
// client wrote and suggests line items from the rate table; staff look at
// the suggestion and decide. Nothing here saves or sends anything.
//
// What leaves Viewora: the description (with phone numbers and email
// addresses taken out), indoors/outdoors, how many areas and floors, and
// the rate table's item names. Never the client's name, number, email, the
// link they gave, or where the place is.
//
// What comes back is only trusted as a list of rate keys and quantities:
// a key that is not in the table, has no published price, or is a
// percentage is dropped, and every price is the rate table's own.

import type { RateItem, RateTable } from './engine/types.js'
import type { DocLine } from './desk.js'

export interface DraftInput {
  description: string
  setting: string | null
  areas: number | null
  floors: number | null
}

export interface Draft {
  lines: DocLine[]
  questions: string[]      // what staff may want to ask the client before sending
  dropped: number          // suggestions thrown out: unknown key, no price, bad quantity
}

export type DraftFn = (prompt: { system: string; user: string }) => Promise<string>

const MAX_QTY = 200
const MAX_LINES = 12

// Phone numbers and email addresses, in case the client typed theirs into the description
export function redact(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[number]')
    .slice(0, 1_000)
}

const PER_UNIT: RateItem['unit'][] = ['scene', 'unit', 'floor', 'visit', 'scenes']

// The items Gemini may choose from, with the price staff would charge
export function catalogue(table: RateTable): Array<{ key: string; label: string; unit: RateItem['unit']; price: number; kind: DocLine['kind'] }> {
  return Object.values(table.items)
    .filter(i => (i.category === 'base' || i.category === 'addon') && !i.custom && i.unit !== 'bp')
    .map(i => ({ i, price: (i.use === 'high' ? i.high ?? i.low : i.low) }))
    .filter((x): x is { i: RateItem; price: number } => x.price !== null && x.price > 0)
    .map(({ i, price }) => ({
      key: i.key, label: i.label, unit: i.unit, price,
      kind: i.category === 'addon' ? 'addon' : PER_UNIT.includes(i.unit) ? 'per_unit' : 'base',
    }))
}

export function draftPrompt(input: DraftInput, table: RateTable): { system: string; user: string } {
  const items = catalogue(table).map(c => `${c.key} | ${c.label} | per ${c.unit}`).join('\n')
  const system = [
    'You help a 360° virtual tour studio in Kenya price unusual jobs.',
    'Pick line items ONLY from the catalogue below, by key. Never invent a key and never state a price.',
    'For a per-scene item, one scene is roughly one room or area. Prefer one base item, then extras the client asked for.',
    'If you cannot tell what is needed, return fewer lines and say what to ask in "questions".',
    'Reply with JSON only: {"lines":[{"key":"...","qty":1,"reason":"short reason"}],"questions":["..."]}',
    '',
    'Catalogue (key | name | charged per):',
    items,
  ].join('\n')
  const user = [
    `What the client wants shot: ${redact(input.description)}`,
    input.setting ? `Indoors or outdoors: ${input.setting}` : null,
    input.areas !== null ? `Rooms or areas: ${input.areas}` : null,
    input.floors !== null ? `Floors: ${input.floors}` : null,
  ].filter(Boolean).join('\n')
  return { system, user }
}

// Gemini's answer → lines priced from the rate table. Anything odd is dropped, not fixed.
export function readDraft(raw: string, table: RateTable): Draft {
  let parsed: any
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    return { lines: [], questions: [], dropped: 0 }
  }
  const byKey = new Map(catalogue(table).map(c => [c.key, c]))
  const suggested: any[] = Array.isArray(parsed?.lines) ? parsed.lines : []
  const lines: DocLine[] = []
  let dropped = 0
  for (const s of suggested) {
    const item = typeof s?.key === 'string' ? byKey.get(s.key) : undefined
    const qty = Number(s?.qty)
    if (!item || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY || lines.length >= MAX_LINES || lines.some(l => l.key === item.key)) {
      dropped++
      continue
    }
    const reason = typeof s.reason === 'string' ? s.reason.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
    lines.push({
      key: item.key, kind: item.kind, label: item.label, qty, unit: item.price, amount: item.price * qty,
      tbc: false, note: reason ? `AI suggestion: ${reason}` : 'AI suggestion',
    })
  }
  const questions = (Array.isArray(parsed?.questions) ? parsed.questions : [])
    .filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0)
    .map((q: string) => q.replace(/\s+/g, ' ').trim().slice(0, 200))
    .slice(0, 5)
  return { lines, questions, dropped }
}
