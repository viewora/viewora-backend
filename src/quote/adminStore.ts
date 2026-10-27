// Read side for the staff admin. Production calls the SQL functions from
// migration-quote-engine-003.sql; tests and local runs read the memory store
// with the same filters, so the admin can be tried without Supabase.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MemoryData } from './store.js'
import { industryHint } from './industries.js'

export type StaffRole = 'admin' | 'sales' | 'viewer'

export interface LeadFilter {
  stage?: string
  industry?: string
  source?: string
  status?: 'completed' | 'abandoned'
  q?: string
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
  // Active qe_staff role, or null if this admin has no staff row
  staffRole(userId: string): Promise<StaffRole | null>
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
    async staffRole(userId) {
      const { data, error } = await db.from('qe_staff').select('role').eq('user_id', userId).eq('active', true).maybeSingle()
      if (error) throw new Error(`quote admin: staff role: ${error.message}`)
      return (data?.role as StaffRole) ?? null
    },
    leads: f => call('qe_admin_leads', {
      p_stage: f.stage ?? null, p_industry: f.industry ?? null, p_source: f.source ?? null,
      p_status: f.status ?? null, p_q: f.q ?? null, p_limit: f.limit, p_offset: f.offset,
    }),
    lead: id => call('qe_admin_lead', { p_id: id }),
    summary: () => call('qe_admin_summary'),
  }
}

// Mirrors qe_admin_leads / qe_admin_lead / qe_admin_summary over memory data
export function memoryAdminStore(data: () => MemoryData, staff: Record<string, StaffRole> = {}): QuoteAdminStore {
  const day = 86_400_000
  const latestRequest = (d: MemoryData, leadId: string) =>
    d.requests.filter(r => r.leadId === leadId).sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt))[0]
  const latestQuote = (d: MemoryData, requestId: string) =>
    d.quotes.filter(q => q.requestId === requestId).at(-1)

  function rows(d: MemoryData): LeadRow[] {
    return d.leads.filter(l => !l.deletedAt).map(l => {
      const r = latestRequest(d, l.id)
      const q = r ? latestQuote(d, r.id) : undefined
      const option = q && ([...q.result.options].sort((a, b) => Number(b.tier === 'standard') - Number(a.tier === 'standard') || a.total - b.total)[0])
      const activity = [l.lastActivityAt, r?.lastSavedAt ?? ''].sort().at(-1)!
      return {
        leadId: l.id, requestId: r?.id ?? null, firstName: l.firstName, whatsapp: l.whatsappE164, email: l.email,
        source: l.source, stage: l.stage, industry: r ? industryHint(r.flags) ?? r.moduleKey : null,
        moduleKey: r?.moduleKey ?? null, clientType: r?.clientType ?? null, stepReached: r?.stepReached ?? 0,
        completed: !!r?.completedAt, flags: r?.flags ?? [], optedOut: false,
        createdAt: l.createdAt, lastActivityAt: activity,
        mode: q?.result.mode ?? null, total: option?.total ?? null, totalHigh: option?.totalHigh ?? null,
      }
    }).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.leadId.localeCompare(b.leadId))
  }

  return {
    async staffRole(userId) { return staff[userId] ?? null },
    async leads(f) {
      const text = f.q?.trim().toLowerCase()
      let digits = text?.replace(/\D/g, '')
      if (digits?.startsWith('0')) digits = `254${digits.slice(1)}`
      const matched = rows(data()).filter(r =>
        (!f.stage || r.stage === f.stage)
        && (!f.source || r.source === f.source)
        && (!f.industry || r.industry === f.industry)
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
      return {
        lead: {
          id: l.id, firstName: l.firstName, whatsapp: l.whatsappE164, email: l.email, source: l.source, utm: l.utm,
          stage: l.stage, consentWhatsapp: l.consentWhatsapp, consentEmail: l.consentEmail, consentAt: l.consentAt,
          consentText: null, optedOutAt: null, createdAt: l.createdAt, lastActivityAt: l.lastActivityAt,
        },
        requests: d.requests.filter(r => r.leadId === id).map(r => ({
          id: r.id, moduleKey: r.moduleKey, moduleVersion: r.moduleVersion, clientType: r.clientType,
          answers: r.answers, entry: r.entry, stepReached: r.stepReached, flags: r.flags, abVariant: r.abVariant,
          startedAt: r.startedAt, lastSavedAt: r.lastSavedAt, completedAt: r.completedAt,
          quotes: d.quotes.filter(q => q.requestId === r.id).reverse().map(q => ({
            id: q.id, mode: q.result.mode, status: q.result.mode === 'custom' ? 'draft' : 'sent', currency: q.result.currency,
            vatCharged: q.result.vat.charged, depositBp: null, validUntil: null, createdAt: q.createdAt,
            warnings: q.result.warnings,
            options: q.result.options.map(o => ({
              tier: o.tier, subtotal: o.subtotal, discount: o.discount, net: o.net, vat: o.vat, total: o.total,
              totalHigh: o.totalHigh ?? null, deposit: o.deposit, selected: o.tier === 'standard',
              lines: o.lines.map(li => ({ kind: li.kind, label: li.label, qty: li.qty, unit: li.unit, amount: li.amount, tbc: !!li.tbc, note: li.note ?? null })),
            })),
          })),
        })),
        messages: d.messages.filter(m => m.leadId === id).reverse().map((m, i) => ({
          id: String(i), channel: m.channel, templateKey: m.templateKey, status: m.status,
          skipReason: m.skipReason ?? null, error: m.error ?? null, sentAt: m.sentAt ?? null, createdAt: m.createdAt,
        })),
        notes: [],
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
