// Storage for the staff side: quote versions, sending, quote links, the lead
// board and the rate table editor. Production calls the SQL functions in
// migration-quote-engine-004.sql (each one a single transaction); tests and
// local runs use the memory version over the same state as memoryStore.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RateItem, RateSettings, RateTable } from './engine/types.js'
import { baselineOf, EDITABLE, type QuoteDoc, type StaffRole } from './desk.js'
import type { MemoryData, MemoryQuote, StoredAnswers } from './store.js'

export interface StaffMember {
  userId: string
  displayName: string
  role: StaffRole
  discountLimitBp: number
  email: string | null
}

export interface LeadBasic {
  id: string
  firstName: string | null
  whatsappE164: string | null
  email: string | null
  stage: string
  ownerStaffId: string | null
  optedOutAt: string | null
}

export interface RequestContext {
  id: string
  leadId: string | null
  moduleKey: string | null
  clientType: string | null
  flags: string[]
  answers: StoredAnswers
  latestQuoteId: string | null
}

export interface LinkHit {
  linkId: string
  expiresAt: string
  revoked: boolean
  quote: QuoteDoc
  lead: LeadBasic | null
  moduleKey: string | null
  flags: string[]
  // Set when a newer version of this quote has been sent
  replacedAt: string | null
}

export interface RateTableMeta {
  id: string
  version: number
  status: 'draft' | 'published' | 'archived'
  effectiveFrom: string
  notes: string | null
  publishedAt: string | null
  publishedBy: string | null
  publishedByName: string | null
  createdAt: string
}

export type FullRateTable = RateTable & RateTableMeta

export interface RateItemPatch {
  label?: string
  low?: number | null
  high?: number | null
  use?: 'low' | 'high'
}

export type LeadStage = 'new' | 'contacted' | 'quoted' | 'booked' | 'delivered' | 'paid' | 'lost'

// A state conflict the route turns into a 409 (or 404 for not_found)
export class DeskError extends Error {
  constructor(public code: string) { super(code) }
}

export interface DeskStore {
  staff(userId: string): Promise<StaffMember | null>
  staffList(): Promise<StaffMember[]>
  lead(id: string): Promise<LeadBasic | null>
  latestRequestId(leadId: string): Promise<string | null>
  request(id: string): Promise<RequestContext | null>
  quote(id: string): Promise<QuoteDoc | null>
  // Inserts (doc.id null, next version for the request) or replaces an
  // editable draft, and writes the audit row. Returns the quote id.
  saveQuote(doc: QuoteDoc, actorId: string, audit: { action: string; reason?: string | null }): Promise<string>
  // Admin decision on a quote waiting for approval; it goes back to draft
  decideApproval(id: string, actorId: string, approve: boolean, reason: string): Promise<void>
  // Marks the quote sent, retires older sent versions, moves the lead to
  // Quoted (from New or Contacted) and stores the hashed link.
  // actorId is null when the follow-up runner sends it
  markSent(id: string, actorId: string | null, link: { tokenHash: string; channel: 'link' | 'whatsapp' | 'email'; expiresAt: string }): Promise<void>
  findLink(tokenHash: string): Promise<LinkHit | null>
  // The client opened the page: counts the view, sets viewed on first open
  linkSeen(linkId: string): Promise<{ firstView: boolean }>
  updateLead(id: string, patch: { stage?: LeadStage; ownerStaffId?: string | null }, actorId: string): Promise<LeadBasic>
  addNote(leadId: string, actorId: string, body: string): Promise<{ id: string; createdAt: string }>
  setQuoteLost(id: string, actorId: string, reason: string): Promise<void>

  rateTables(): Promise<RateTableMeta[]>
  rateTable(id: string): Promise<FullRateTable | null>
  // A draft copy of a table; only one draft may exist at a time
  createRateDraft(fromId: string, actorId: string): Promise<string>
  updateRateItem(id: string, key: string, patch: RateItemPatch, actorId: string): Promise<void>
  updateRateSettings(id: string, settings: RateSettings, actorId: string): Promise<void>
  publishRateTable(id: string, actorId: string, notes: string | null): Promise<void>
  deleteRateDraft(id: string, actorId: string): Promise<void>
  // Quotes still in play (draft, waiting, sent or viewed) built on a table
  openQuotesOn(rateTableId: string): Promise<number>
}

// ── Memory ──────────────────────────────────────────────────────────────────

const OPEN: QuoteDoc['status'][] = ['draft', 'needs_approval', 'sent', 'viewed']

export function memoryDeskStore(data: () => MemoryData): DeskStore {
  const now = () => data().clock().toISOString()
  const d = () => data()
  const staffById = (id: string | null) => d().staff.find(s => s.userId === id)
  const audit = (actorId: string | null, entityType: string, entityId: string, action: string, before: unknown, after: unknown, reason: string | null = null) => {
    const list = d().audit
    list.push({ id: list.length + 1, actorId, entityType, entityId, action, before: structuredClone(before ?? null), after: structuredClone(after ?? null), reason, createdAt: now() })
  }
  const leadBasic = (id: string): LeadBasic | null => {
    const l = d().leads.find(x => x.id === id && !x.deletedAt)
    return l ? { id: l.id, firstName: l.firstName, whatsappE164: l.whatsappE164, email: l.email, stage: l.stage, ownerStaffId: l.ownerStaffId, optedOutAt: l.optedOutAt } : null
  }
  const quoteRow = (id: string) => {
    const q = d().quotes.find(x => x.id === id)
    if (!q) throw new DeskError('not_found')
    return q
  }
  const toDoc = (q: MemoryQuote): QuoteDoc => {
    const { trace, updatedAt: _u, ...doc } = structuredClone(q)
    return { ...doc, baseline: Object.keys(doc.baseline ?? {}).length ? doc.baseline : trace ? baselineOf(trace) : {} }
  }
  const table = (id: string) => {
    const t = d().rateTables.find(x => x.id === id)
    if (!t) throw new DeskError('not_found')
    return t
  }
  const meta = (t: MemoryData['rateTables'][number]): RateTableMeta => ({
    id: t.id, version: t.version, status: t.status, effectiveFrom: t.effectiveFrom, notes: t.notes,
    publishedAt: t.publishedAt, publishedBy: t.publishedBy, publishedByName: staffById(t.publishedBy)?.displayName ?? null, createdAt: t.createdAt,
  })
  const draftOnly = (id: string) => {
    const t = table(id)
    if (t.status !== 'draft') throw new DeskError('not_draft')
    return t
  }

  return {
    async staff(userId) {
      const s = d().staff.find(x => x.userId === userId && x.active)
      return s ? { userId: s.userId, displayName: s.displayName, role: s.role, discountLimitBp: s.discountLimitBp, email: s.email } : null
    },
    async staffList() {
      return d().staff.filter(s => s.active).map(s => ({ userId: s.userId, displayName: s.displayName, role: s.role, discountLimitBp: s.discountLimitBp, email: s.email }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
    },
    async lead(id) { return leadBasic(id) },
    async latestRequestId(leadId) {
      return d().requests.filter(r => r.leadId === leadId).sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt))[0]?.id ?? null
    },
    async request(id) {
      const r = d().requests.find(x => x.id === id)
      if (!r) return null
      const latest = d().quotes.filter(q => q.requestId === id).sort((a, b) => b.version - a.version)[0]
      return { id: r.id, leadId: r.leadId, moduleKey: r.moduleKey, clientType: r.clientType, flags: [...r.flags], answers: structuredClone(r.answers), latestQuoteId: latest?.id ?? null }
    },
    async quote(id) {
      const q = d().quotes.find(x => x.id === id)
      return q ? toDoc(q) : null
    },
    async saveQuote(doc, actorId, a) {
      if (!doc.id) {
        const id = randomUUID()
        const version = Math.max(0, ...d().quotes.filter(q => q.requestId === doc.requestId).map(q => q.version)) + 1
        const row: MemoryQuote = { ...structuredClone(doc), id, version, createdAt: now(), updatedAt: now(), trace: null }
        d().quotes.push(row)
        audit(actorId, 'quote', id, a.action, null, toDoc(row), a.reason ?? null)
        return id
      }
      const q = quoteRow(doc.id)
      if (!EDITABLE.includes(q.status)) throw new DeskError('locked')
      const before = toDoc(q)
      Object.assign(q, {
        status: doc.status, currency: doc.currency, vatCharged: doc.vatCharged, depositBp: doc.depositBp, validUntil: doc.validUntil,
        discountReason: doc.discountReason, discountApprovedBy: doc.discountApprovedBy, clientNote: doc.clientNote,
        options: structuredClone(doc.options), warnings: structuredClone(doc.warnings), updatedAt: now(),
      })
      audit(actorId, 'quote', q.id, a.action, before, toDoc(q), a.reason ?? null)
      return q.id
    },
    async decideApproval(id, actorId, approve, reason) {
      const q = quoteRow(id)
      if (q.status !== 'needs_approval') throw new DeskError('not_waiting')
      const before = toDoc(q)
      q.status = 'draft'
      q.discountApprovedBy = approve ? actorId : null
      q.updatedAt = now()
      audit(actorId, 'quote', id, approve ? 'discount_approved' : 'discount_rejected', before, toDoc(q), reason)
    },
    async markSent(id, actorId, link) {
      const q = quoteRow(id)
      if (!['draft', 'sent', 'viewed'].includes(q.status)) throw new DeskError(q.status === 'needs_approval' ? 'needs_approval' : 'locked')
      const before = q.status
      if (q.status === 'draft') { q.status = 'sent'; q.sentAt = now() }
      q.updatedAt = now()
      for (const other of d().quotes) {
        if (other.requestId === q.requestId && other.id !== q.id && other.version < q.version && ['sent', 'viewed'].includes(other.status)) {
          other.status = 'superseded'
          other.updatedAt = now()
        }
      }
      const lead = d().leads.find(l => l.id === q.leadId)
      if (lead && ['new', 'contacted'].includes(lead.stage)) {
        audit(actorId, 'lead', lead.id, 'stage_changed', { stage: lead.stage }, { stage: 'quoted' }, 'quote sent')
        lead.stage = 'quoted'
      }
      d().links.push({ id: randomUUID(), quoteId: id, tokenHash: link.tokenHash, channel: link.channel, createdBy: actorId, createdAt: now(), expiresAt: link.expiresAt, revokedAt: null, firstViewedAt: null, lastViewedAt: null, views: 0 })
      audit(actorId, 'quote', id, `sent_${link.channel}`, { status: before }, { status: q.status }, null)
    },
    async findLink(tokenHash) {
      const link = d().links.find(l => l.tokenHash === tokenHash)
      if (!link) return null
      const q = d().quotes.find(x => x.id === link.quoteId)
      if (!q) return null
      const r = d().requests.find(x => x.id === q.requestId)
      const newer = d().quotes.filter(x => x.requestId === q.requestId && x.version > q.version && x.sentAt).sort((a, b) => a.version - b.version)[0]
      return {
        linkId: link.id, expiresAt: link.expiresAt, revoked: !!link.revokedAt, quote: toDoc(q),
        lead: q.leadId ? leadBasic(q.leadId) : null, moduleKey: r?.moduleKey ?? null, flags: r?.flags ?? [],
        replacedAt: q.status === 'superseded' ? newer?.sentAt ?? q.updatedAt : null,
      }
    },
    async linkSeen(linkId) {
      const link = d().links.find(l => l.id === linkId)
      if (!link) throw new DeskError('not_found')
      link.views += 1
      link.firstViewedAt ??= now()
      link.lastViewedAt = now()
      const q = quoteRow(link.quoteId)
      const firstView = !q.viewedAt
      if (firstView) q.viewedAt = now()
      if (q.status === 'sent') q.status = 'viewed'
      const lead = d().leads.find(l => l.id === q.leadId)
      if (lead) lead.lastActivityAt = now()
      return { firstView }
    },
    async updateLead(id, patch, actorId) {
      const l = d().leads.find(x => x.id === id && !x.deletedAt)
      if (!l) throw new DeskError('not_found')
      if (patch.stage !== undefined && patch.stage !== l.stage) {
        audit(actorId, 'lead', id, 'stage_changed', { stage: l.stage }, { stage: patch.stage })
        l.stage = patch.stage
      }
      if (patch.ownerStaffId !== undefined && patch.ownerStaffId !== l.ownerStaffId) {
        if (patch.ownerStaffId && !staffById(patch.ownerStaffId)?.active) throw new DeskError('owner_not_staff')
        audit(actorId, 'lead', id, 'owner_changed', { ownerStaffId: l.ownerStaffId }, { ownerStaffId: patch.ownerStaffId })
        l.ownerStaffId = patch.ownerStaffId
      }
      return leadBasic(id)!
    },
    async addNote(leadId, actorId, body) {
      if (!leadBasic(leadId)) throw new DeskError('not_found')
      const note = { id: randomUUID(), leadId, authorId: actorId, body, createdAt: now() }
      d().notes.push(note)
      return { id: note.id, createdAt: note.createdAt }
    },
    async setQuoteLost(id, actorId, reason) {
      const q = quoteRow(id)
      if (['accepted', 'lost', 'superseded'].includes(q.status)) throw new DeskError('locked')
      const before = q.status
      q.status = 'lost'
      q.updatedAt = now()
      audit(actorId, 'quote', id, 'marked_lost', { status: before }, { status: 'lost' }, reason)
    },

    async rateTables() {
      return d().rateTables.map(meta).sort((a, b) => b.version - a.version)
    },
    async rateTable(id) {
      const t = d().rateTables.find(x => x.id === id)
      return t ? { ...structuredClone(t), ...meta(t) } : null
    },
    async createRateDraft(fromId, actorId) {
      if (d().rateTables.some(t => t.status === 'draft')) throw new DeskError('draft_exists')
      const from = table(fromId)
      const id = randomUUID()
      const version = Math.max(...d().rateTables.map(t => t.version)) + 1
      d().rateTables.push({
        ...structuredClone(from), id, version, status: 'draft', notes: null, publishedAt: null, publishedBy: null,
        createdAt: now(), effectiveFrom: now().slice(0, 10),
      })
      audit(actorId, 'rate_table', id, 'draft_created', null, { fromVersion: from.version, version })
      return id
    },
    async updateRateItem(id, key, patch, actorId) {
      const t = draftOnly(id)
      const item = t.items[key]
      if (!item) throw new DeskError('not_found')
      const before: Partial<RateItem> = { label: item.label, low: item.low, high: item.high, use: item.use }
      Object.assign(item, patch)
      audit(actorId, 'rate_item', `${t.version}:${key}`, 'updated', before, { label: item.label, low: item.low, high: item.high, use: item.use })
    },
    async updateRateSettings(id, settings, actorId) {
      const t = draftOnly(id)
      const before = t.settings
      t.settings = structuredClone(settings)
      audit(actorId, 'rate_table', id, 'settings_updated', before, settings)
    },
    async publishRateTable(id, actorId, notes) {
      const t = draftOnly(id)
      for (const other of d().rateTables) if (other.status === 'published') other.status = 'archived'
      Object.assign(t, { status: 'published', publishedAt: now(), publishedBy: actorId, notes, effectiveFrom: now().slice(0, 10) })
      audit(actorId, 'rate_table', id, 'published', null, { version: t.version }, notes)
    },
    async deleteRateDraft(id, actorId) {
      const t = draftOnly(id)
      d().rateTables.splice(d().rateTables.indexOf(t), 1)
      audit(actorId, 'rate_table', id, 'draft_deleted', { version: t.version }, null)
    },
    async openQuotesOn(rateTableId) {
      return d().quotes.filter(q => q.rateTableId === rateTableId && OPEN.includes(q.status)).length
    },
  }
}

// ── Supabase ────────────────────────────────────────────────────────────────

// SQL functions raise 'qe:<code>' for state conflicts
function rethrow(fn: string, error: { message: string }): never {
  const code = /qe:([a-z_]+)/.exec(error.message)?.[1]
  if (code) throw new DeskError(code)
  throw new Error(`quote desk: ${fn}: ${error.message}`)
}

function normaliseDoc(raw: any): QuoteDoc | null {
  if (!raw) return null
  const { trace, ...doc } = raw
  const baseline = doc.baseline && Object.keys(doc.baseline).length ? doc.baseline : trace?.options ? baselineOf(trace) : {}
  return { ...doc, baseline, warnings: doc.warnings ?? trace?.warnings ?? [] } as QuoteDoc
}

export function supabaseDeskStore(db: SupabaseClient): DeskStore {
  const call = async <T>(fn: string, args?: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args)
    if (error) rethrow(fn, error)
    return data as T
  }
  return {
    staff: async userId => (await call<StaffMember | null>('qe_desk_staff', { p_user: userId })) ?? null,
    staffList: () => call('qe_desk_staff_list'),
    lead: async id => (await call<LeadBasic | null>('qe_desk_lead', { p_id: id })) ?? null,
    latestRequestId: async leadId => (await call<string | null>('qe_desk_latest_request', { p_lead: leadId })) ?? null,
    request: async id => (await call<RequestContext | null>('qe_desk_request', { p_id: id })) ?? null,
    quote: async id => normaliseDoc(await call('qe_desk_quote', { p_id: id })),
    saveQuote: (doc, actorId, a) => call('qe_desk_save_quote', { p_doc: doc, p_trace: null, p_actor: actorId, p_action: a.action, p_reason: a.reason ?? null }),
    decideApproval: (id, actorId, approve, reason) => call('qe_desk_decide_approval', { p_id: id, p_actor: actorId, p_approve: approve, p_reason: reason }),
    markSent: (id, actorId, link) => call('qe_desk_mark_sent', { p_id: id, p_actor: actorId, p_token_hash: link.tokenHash, p_channel: link.channel, p_expires: link.expiresAt }),
    async findLink(tokenHash) {
      const hit = await call<any>('qe_desk_find_link', { p_token_hash: tokenHash })
      return hit ? { ...hit, quote: normaliseDoc(hit.quote)! } : null
    },
    linkSeen: linkId => call('qe_desk_link_seen', { p_link: linkId }),
    updateLead: (id, patch, actorId) => call('qe_desk_update_lead', { p_id: id, p_patch: patch, p_actor: actorId }),
    addNote: (leadId, actorId, body) => call('qe_desk_add_note', { p_lead: leadId, p_actor: actorId, p_body: body }),
    setQuoteLost: (id, actorId, reason) => call('qe_desk_quote_lost', { p_id: id, p_actor: actorId, p_reason: reason }),

    rateTables: () => call('qe_rt_list'),
    rateTable: async id => (await call<FullRateTable | null>('qe_rt_get', { p_id: id })) ?? null,
    createRateDraft: (fromId, actorId) => call('qe_rt_create_draft', { p_from: fromId, p_actor: actorId }),
    updateRateItem: (id, key, patch, actorId) => call('qe_rt_update_item', { p_id: id, p_key: key, p_patch: patch, p_actor: actorId }),
    updateRateSettings: (id, settings, actorId) => call('qe_rt_update_settings', { p_id: id, p_settings: settings, p_actor: actorId }),
    publishRateTable: (id, actorId, notes) => call('qe_rt_publish', { p_id: id, p_actor: actorId, p_notes: notes }),
    deleteRateDraft: (id, actorId) => call('qe_rt_delete_draft', { p_id: id, p_actor: actorId }),
    openQuotesOn: rateTableId => call('qe_rt_open_quotes', { p_id: rateTableId }),
  }
}
