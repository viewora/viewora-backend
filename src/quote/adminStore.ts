// Read side for the staff admin. Production calls the SQL functions from
// migrations 003 and 004 (qe_admin_leads_v2, qe_admin_lead_v2,
// qe_admin_summary); tests and local runs read the memory store with the
// same filters, so the admin can be tried without Supabase.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MemoryData } from './store.js'
import { industryHint } from './industries.js'

export type { StaffRole } from './desk.js'

export interface LeadFilter {
  stage?: string
  industry?: string
  source?: string
  status?: 'completed' | 'abandoned'
  q?: string
  owner?: string          // staff uuid, or 'none' for unassigned
  limit: number
  offset: number
}

export interface LeadRow {
  leadId: string
  requestId: string | null
  firstName: string | null
  whatsapp: string | null
  email: string | null
  source: string | null
  stage: string
  industry: string | null
  moduleKey: string | null
  clientType: string | null
  stepReached: number
  completed: boolean
  flags: string[]
  optedOut: boolean
  createdAt: string
  lastActivityAt: string
  mode: string | null
  quoteStatus: string | null
  needsApproval: boolean
  ownerId: string | null
  ownerName: string | null
  total: number | null
  totalHigh: number | null
}

export interface LeadSummary {
  newToday: number
  leads7d: number
  completed7d: number
  noContact7d: number
  abandonedByStep: Record<string, number>
  sources: string[]
  industries: string[]
}

export interface QuoteAdminStore {
  leads(filter: LeadFilter): Promise<{ total: number; rows: LeadRow[] }>
  lead(id: string): Promise<Record<string, unknown> | null>
  summary(): Promise<LeadSummary>
}

export function supabaseAdminStore(db: SupabaseClient): QuoteAdminStore {
  const call = async <T>(fn: string, args?: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args)
    if (error) throw new Error(`quote admin: ${fn}: ${error.message}`)
    return data as T
  }
  return {
    leads: f => call('qe_admin_leads_v2', {
      p_stage: f.stage ?? null, p_industry: f.industry ?? null, p_source: f.source ?? null,
      p_status: f.status ?? null, p_q: f.q ?? null, p_limit: f.limit, p_offset: f.offset, p_owner: f.owner ?? null,
    }),
    lead: id => call('qe_admin_lead_v2', { p_id: id }),
    summary: () => call('qe_admin_summary'),
  }
}

// Mirrors qe_admin_leads_v2 / qe_admin_lead_v2 / qe_admin_summary over memory data
export function memoryAdminStore(data: () => MemoryData): QuoteAdminStore {
  const day = 86_400_000
  const latestRequest = (d: MemoryData, leadId: string) =>
    d.requests.filter(r => r.leadId === leadId).sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt))[0]
  const latestQuote = (d: MemoryData, requestId: string) =>
    d.quotes.filter(q => q.requestId === requestId).sort((a, b) => b.version - a.version)[0]
  const staffName = (d: MemoryData, id: string | null) => d.staff.find(s => s.userId === id)?.displayName ?? null
  const totalHigh = (q: MemoryData['quotes'][number], tier: string) => q.trace?.options.find(o => o.tier === tier)?.totalHigh ?? null

  function rows(d: MemoryData): LeadRow[] {
    return d.leads.filter(l => !l.deletedAt).map(l => {
      const r = latestRequest(d, l.id)
      const q = r ? latestQuote(d, r.id) : undefined
      const option = q && [...q.options].sort((a, b) =>
        Number(b.selected) - Number(a.selected) || Number(b.tier === 'standard') - Number(a.tier === 'standard') || a.total - b.total)[0]
      const activity = [l.lastActivityAt, r?.lastSavedAt ?? ''].sort().at(-1)!
      const requestIds = new Set(d.requests.filter(x => x.leadId === l.id).map(x => x.id))
      return {
        leadId: l.id, requestId: r?.id ?? null, firstName: l.firstName, whatsapp: l.whatsappE164, email: l.email,
        source: l.source, stage: l.stage, industry: r ? industryHint(r.flags) ?? r.moduleKey : null,
        moduleKey: r?.moduleKey ?? null, clientType: r?.clientType ?? null, stepReached: r?.stepReached ?? 0,
        completed: !!r?.completedAt, flags: r?.flags ?? [], optedOut: !!l.optedOutAt,
        createdAt: l.createdAt, lastActivityAt: activity,
        mode: q?.mode ?? null, quoteStatus: q?.status ?? null,
        needsApproval: d.quotes.some(x => requestIds.has(x.requestId) && x.status === 'needs_approval'),
        ownerId: l.ownerStaffId, ownerName: staffName(d, l.ownerStaffId),
        total: option?.total ?? null, totalHigh: q && option ? totalHigh(q, option.tier) : null,
      }
    }).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.leadId.localeCompare(b.leadId))
  }

  return {
    async leads(f) {
      const text = f.q?.trim().toLowerCase()
      let digits = text?.replace(/\D/g, '')
      if (digits?.startsWith('0')) digits = `254${digits.slice(1)}`
      const matched = rows(data()).filter(r =>
        (!f.stage || r.stage === f.stage)
        && (!f.source || r.source === f.source)
        && (!f.industry || r.industry === f.industry)
        && (!f.owner || (f.owner === 'none' ? !r.ownerId : r.ownerId === f.owner))
        && (!f.status || (f.status === 'completed') === r.completed)
        && (!text || !!r.firstName?.toLowerCase().includes(text) || !!r.email?.toLowerCase().includes(text)
          || (!!digits && !!r.whatsapp?.includes(digits))))
      const limit = Math.min(Math.max(f.limit, 1), 200)
      return { total: matched.length, rows: matched.slice(f.offset, f.offset + limit) }
    },
    async lead(id) {
      const d = data()
      const l = d.leads.find(x => x.id === id && !x.deletedAt)
      if (!l) return null
      const requests = d.requests.filter(r => r.leadId === id).sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt))
      const quoteIds = new Set(d.quotes.filter(q => requests.some(r => r.id === q.requestId)).map(q => q.id))
      return {
        lead: {
          id: l.id, firstName: l.firstName, whatsapp: l.whatsappE164, email: l.email, source: l.source, utm: l.utm,
          stage: l.stage, ownerId: l.ownerStaffId, ownerName: staffName(d, l.ownerStaffId),
          consentWhatsapp: l.consentWhatsapp, consentEmail: l.consentEmail, consentAt: l.consentAt,
          consentText: null, optedOutAt: l.optedOutAt, createdAt: l.createdAt, lastActivityAt: l.lastActivityAt,
        },
        requests: requests.map(r => ({
          id: r.id, moduleKey: r.moduleKey, moduleVersion: r.moduleVersion, clientType: r.clientType,
          answers: r.answers, entry: r.entry, stepReached: r.stepReached, flags: r.flags, abVariant: r.abVariant,
          startedAt: r.startedAt, lastSavedAt: r.lastSavedAt, completedAt: r.completedAt,
          quotes: d.quotes.filter(q => q.requestId === r.id).sort((a, b) => b.version - a.version).map(q => {
            const links = d.links.filter(k => k.quoteId === q.id)
            return {
              id: q.id, version: q.version, supersedesId: q.supersedesId, mode: q.mode, status: q.status, currency: q.currency,
              vatCharged: q.vatCharged, depositBp: q.depositBp, validUntil: q.validUntil,
              discountReason: q.discountReason, clientNote: q.clientNote,
              createdAt: q.createdAt, sentAt: q.sentAt, viewedAt: q.viewedAt, createdByName: staffName(d, q.createdBy),
              links: {
                count: links.length, views: links.reduce((s, k) => s + k.views, 0),
                lastViewedAt: links.map(k => k.lastViewedAt).filter(Boolean).sort().at(-1) ?? null,
              },
              warnings: q.warnings,
              options: q.options.map(o => ({
                tier: o.tier, subtotal: o.subtotal, discount: o.discount, net: o.net, vat: o.vat, total: o.total,
                totalHigh: totalHigh(q, o.tier), deposit: o.deposit, selected: o.selected,
                lines: o.lines.map(li => ({ kind: li.kind, label: li.label, qty: li.qty, unit: li.unit, amount: li.amount, tbc: li.tbc, note: li.note })),
              })),
            }
          }),
        })),
        messages: d.messages.filter(m => m.leadId === id).reverse().map(m => ({
          id: m.id, channel: m.channel, templateKey: m.templateKey, status: m.status, quoteId: m.quoteId ?? null,
          skipReason: m.skipReason ?? null, error: m.error ?? null, sentAt: m.sentAt ?? null, createdAt: m.createdAt,
        })),
        notes: d.notes.filter(n => n.leadId === id).reverse()
          .map(n => ({ id: n.id, body: n.body, authorId: n.authorId, authorName: staffName(d, n.authorId), createdAt: n.createdAt })),
        // Staff changes to this lead and its quotes, newest first
        activity: d.audit
          .filter(a => (a.entityType === 'lead' && a.entityId === id) || (a.entityType === 'quote' && quoteIds.has(a.entityId)))
          .reverse().slice(0, 100)
          .map(a => ({
            id: a.id, entityType: a.entityType, entityId: a.entityId, action: a.action, actorName: staffName(d, a.actorId),
            before: a.before, after: a.after, reason: a.reason, createdAt: a.createdAt,
          })),
      }
    },
    async summary() {
      const d = data()
      const now = Date.now()
      const nairobiMidnight = (() => {
        const eat = new Date(now + 3 * 3_600_000)          // EAT is UTC+3 all year
        return Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate()) - 3 * 3_600_000
      })()
      const live = d.leads.filter(l => !l.deletedAt)
      const abandoned: Record<string, number> = {}
      for (const r of d.requests) {
        if (!r.completedAt && now - Date.parse(r.startedAt) < 30 * day) abandoned[r.stepReached] = (abandoned[r.stepReached] ?? 0) + 1
      }
      return {
        newToday: live.filter(l => Date.parse(l.createdAt) >= nairobiMidnight).length,
        leads7d: live.filter(l => now - Date.parse(l.createdAt) < 7 * day).length,
        completed7d: d.requests.filter(r => r.completedAt && now - Date.parse(r.completedAt) < 7 * day).length,
        noContact7d: d.requests.filter(r => !r.leadId && now - Date.parse(r.startedAt) < 7 * day).length,
        abandonedByStep: abandoned,
        sources: [...new Set(live.map(l => l.source).filter((s): s is string => !!s))].sort(),
        industries: [...new Set(d.requests.filter(r => r.leadId).map(r => industryHint(r.flags) ?? r.moduleKey).filter((s): s is string => !!s))].sort(),
      }
    },
  }
}
