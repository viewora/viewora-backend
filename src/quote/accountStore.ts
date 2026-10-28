// Ordering from a Viewora account (Phase 5b): which signed-in user started
// a request, the lead that is theirs, and what their profile already says.
// Reads profiles and auth users; writes only qe_* tables (migration 009).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MemoryData } from './store.js'
import { industryHint } from './industries.js'

export interface AccountProfile { fullName: string | null; phone: string | null; email: string | null }

// A lead of theirs that already agreed to messages: the contact step can be skipped
export interface AccountLead { id: string; firstName: string | null; whatsappE164: string; email: string | null }

export interface AccountOrder { startedAt: string; industry: string | null; completed: boolean; stage: string | null }

export interface AccountStore {
  profile(userId: string): Promise<AccountProfile>
  markRequest(requestId: string, userId: string): Promise<boolean>   // false if another account has it
  requestUser(requestId: string): Promise<string | null>
  linkLead(leadId: string, userId: string): Promise<boolean>
  leadUser(leadId: string): Promise<string | null>
  consentedLead(userId: string): Promise<AccountLead | null>
  orders(userId: string, limit: number): Promise<AccountOrder[]>
}

export interface MemoryAccounts {
  requests: Record<string, string>          // request id → user id
  profiles: Record<string, AccountProfile>  // what the profiles table and auth would say
}

export function accountStoreFor(store: object, db: SupabaseClient): AccountStore {
  const dump = (store as { dump?: () => MemoryData }).dump
  return dump ? memoryAccountStore(dump) : supabaseAccountStore(db)
}

export function memoryAccountStore(data: () => MemoryData): AccountStore {
  const d = () => data()
  const leadsOf = (userId: string) => d().leads.filter(l => l.userId === userId && !l.deletedAt)
  return {
    async profile(userId) {
      return d().accounts.profiles[userId] ?? { fullName: null, phone: null, email: null }
    },
    async markRequest(requestId, userId) {
      const owner = d().accounts.requests[requestId]
      if (owner && owner !== userId) return false
      d().accounts.requests[requestId] = userId
      return true
    },
    async requestUser(requestId) {
      return d().accounts.requests[requestId] ?? null
    },
    async linkLead(leadId, userId) {
      const lead = d().leads.find(l => l.id === leadId && !l.deletedAt)
      if (!lead || lead.userId) return false
      lead.userId = userId
      d().audit.push({ id: d().audit.length + 1, actorId: null, entityType: 'lead', entityId: leadId, action: 'account_linked', before: null, after: { userId }, reason: null, createdAt: d().clock().toISOString() })
      return true
    },
    async leadUser(leadId) {
      return d().leads.find(l => l.id === leadId)?.userId ?? null
    },
    async consentedLead(userId) {
      const lead = leadsOf(userId).filter(l => l.consentWhatsapp && !l.optedOutAt && l.whatsappE164)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0]
      return lead ? { id: lead.id, firstName: lead.firstName, whatsappE164: lead.whatsappE164, email: lead.email } : null
    },
    async orders(userId, limit) {
      const mine = new Set(leadsOf(userId).map(l => l.id))
      return d().requests
        .filter(r => d().accounts.requests[r.id] === userId || (r.leadId && mine.has(r.leadId)))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
        .map(r => ({
          startedAt: r.startedAt,
          industry: industryHint(r.flags) ?? r.moduleKey,
          completed: !!r.completedAt,
          stage: r.leadId ? d().leads.find(l => l.id === r.leadId)?.stage ?? null : null,
        }))
    },
  }
}

export function supabaseAccountStore(db: SupabaseClient): AccountStore {
  const fail = (error: { message: string } | null, what: string) => { if (error) throw new Error(`account ${what}: ${error.message}`) }
  return {
    async profile(userId) {
      const [{ data: row, error }, auth] = await Promise.all([
        db.from('profiles').select('full_name, phone').eq('id', userId).maybeSingle(),
        db.auth.admin.getUserById(userId),
      ])
      fail(error, 'profile')
      return { fullName: row?.full_name ?? null, phone: row?.phone ?? null, email: auth.data.user?.email ?? null }
    },
    async markRequest(requestId, userId) {
      const { data, error } = await db.from('qe_quote_requests').update({ user_id: userId })
        .eq('id', requestId).or(`user_id.is.null,user_id.eq.${userId}`).select('id')
      fail(error, 'mark request')
      return (data ?? []).length === 1
    },
    async requestUser(requestId) {
      const { data, error } = await db.from('qe_quote_requests').select('user_id').eq('id', requestId).maybeSingle()
      fail(error, 'request user')
      return data?.user_id ?? null
    },
    async linkLead(leadId, userId) {
      const { data, error } = await db.rpc('qe_lead_link_account', { p_lead: leadId, p_user: userId })
      fail(error, 'link lead')
      return data === true
    },
    async leadUser(leadId) {
      const { data, error } = await db.from('qe_leads').select('user_id').eq('id', leadId).maybeSingle()
      fail(error, 'lead user')
      return data?.user_id ?? null
    },
    async consentedLead(userId) {
      const { data, error } = await db.from('qe_leads').select('id, first_name, whatsapp_e164, email')
        .eq('user_id', userId).eq('consent_whatsapp', true).is('opted_out_at', null).is('deleted_at', null)
        .not('whatsapp_e164', 'is', null).order('last_activity_at', { ascending: false }).limit(1).maybeSingle()
      fail(error, 'consented lead')
      return data ? { id: data.id, firstName: data.first_name, whatsappE164: data.whatsapp_e164, email: data.email } : null
    },
    async orders(userId, limit) {
      const { data: leads, error: leadErr } = await db.from('qe_leads').select('id').eq('user_id', userId).is('deleted_at', null)
      fail(leadErr, 'orders')
      const ids = (leads ?? []).map(l => l.id)
      const filter = ids.length ? `user_id.eq.${userId},lead_id.in.(${ids.join(',')})` : `user_id.eq.${userId}`
      const { data, error } = await db.from('qe_quote_requests')
        .select('module_key, flags, started_at, completed_at, lead:qe_leads(stage)')
        .or(filter).order('started_at', { ascending: false }).limit(limit)
      fail(error, 'orders')
      return (data ?? []).map((r: any) => ({
        startedAt: r.started_at,
        industry: industryHint(r.flags ?? []) ?? r.module_key,
        completed: !!r.completed_at,
        stage: r.lead?.stage ?? null,
      }))
    },
  }
}
