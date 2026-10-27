// What a client sees when they open a quote link: only their first name,
// the prices and the terms. No staff notes, rate keys, engine trace or
// contact details, so a forwarded link leaks nothing else.

import type { LineKind, Tier } from './engine/types.js'
import type { LinkHit } from './deskStore.js'
import { modules } from './modules/index.js'
import { industryLabel } from './industries.js'
import { nairobiDate } from './desk.js'

// open: current price · expired: shown, but the price date has passed ·
// replaced / closed / gone: nothing priced is shown
export type PublicState = 'open' | 'expired' | 'accepted' | 'replaced' | 'closed' | 'gone'

export interface PublicLine { kind: LineKind; label: string; qty: number; unit: number; amount: number }

export interface PublicOption {
  tier: Tier
  recommended: boolean
  lines: PublicLine[]
  subtotal: number
  discount: number
  net: number
  vat: number
  total: number
  deposit: number
}

export interface PublicQuote {
  state: PublicState
  replacedAt?: string | null
  ref?: string
  version?: number
  firstName?: string | null
  industry?: string
  sentAt?: string | null
  validUntil?: string | null
  currency?: 'KES' | 'USD'
  vatCharged?: boolean
  vatRateBp?: number
  depositBp?: number
  clientNote?: string | null
  options?: PublicOption[]
}

export const quoteRef = (id: string, version: number) => `Q-${id.slice(0, 8).toUpperCase()}-${version}`

export function publicQuote(hit: LinkHit, now: Date): PublicQuote {
  const q = hit.quote
  if (hit.revoked || Date.parse(hit.expiresAt) < now.getTime()) return { state: 'gone' }
  if (q.status === 'superseded') return { state: 'replaced', replacedAt: hit.replacedAt }
  if (q.status === 'lost' || q.status === 'draft' || q.status === 'needs_approval') return { state: 'closed' }
  const state: PublicState = q.status === 'accepted' ? 'accepted'
    : q.validUntil && q.validUntil < nairobiDate(now) ? 'expired' : 'open'
  return {
    state,
    ref: quoteRef(q.id!, q.version),
    version: q.version,
    firstName: hit.lead?.firstName ?? null,
    industry: industryLabel(hit.moduleKey, hit.flags, hit.moduleKey ? modules[hit.moduleKey]?.label : undefined),
    sentAt: q.sentAt,
    validUntil: q.validUntil,
    currency: q.currency,
    vatCharged: q.vatCharged,
    vatRateBp: q.vatRateBp,
    depositBp: q.depositBp,
    clientNote: q.clientNote,
    options: q.options.map(o => ({
      tier: o.tier, recommended: o.selected,
      lines: o.lines.map(l => ({ kind: l.kind, label: l.label, qty: l.qty, unit: l.unit, amount: l.amount })),
      subtotal: o.subtotal, discount: o.discount, net: o.net, vat: o.vat, total: o.total, deposit: o.deposit,
    })),
  }
}
