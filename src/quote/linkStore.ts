// Storage for /q/:code links, partners and commission payouts. Production
// uses the qe_* tables and functions from migration 007; tests and local
// runs use the shared in-memory state.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MemoryData } from './store.js'
import { linkState, type CommissionJob, type EntryLink, type LinkKind, type LinkPrefill, type LinkState, type Partner } from './links.js'

export interface NewLink {
  kind: LinkKind
  key: string                      // hash for a DM link, the code itself for a campaign link
  label: string | null
  prefill: LinkPrefill
  leadId: string | null
  createdBy: string
  maxUses: number | null
  expiresAt: string | null
}

export interface PartnerInput {
  name: string
  code: string
  commissionType: 'percent' | 'fixed'
  commissionValue: number
  active: boolean
}

export interface LinkStore {
  createLink(input: NewLink): Promise<EntryLink>
  // Any link by its stored key, whatever its state
  findLink(key: string): Promise<(EntryLink & { key: string }) | null>
  // Counts one start of the form; null when the link can no longer be used
  useLink(key: string, now: Date): Promise<{ link: EntryLink; state: LinkState }>
  listLinks(filter: { kind?: LinkKind; leadId?: string }): Promise<EntryLink[]>
  revokeLink(id: string, actor: string): Promise<EntryLink | null>
  // The visitor gave their number: tie a DM link to the lead, and give the
  // lead to whoever made the link if nobody owns it yet
  attachLead(key: string, leadId: string): Promise<void>
  // First partner wins: a lead that already has one keeps it
  creditPartner(leadId: string, code: string): Promise<boolean>
  leadPartner(leadId: string): Promise<Partner | null>
  partners(): Promise<Partner[]>
  partnerByCode(code: string): Promise<Partner | null>
  createPartner(input: PartnerInput, actor: string): Promise<Partner>
  updatePartner(id: string, patch: Partial<PartnerInput>, actor: string): Promise<Partner | null>
  commissionJobs(filter: { partnerId?: string }): Promise<CommissionJob[]>
  // Records payouts for jobs not yet paid out; returns how many were recorded
  recordPayouts(items: Array<{ jobId: string; amount: number }>, reference: string | null, actor: string): Promise<number>
}

export function linkStoreFor(store: object, db: SupabaseClient): LinkStore {
  const dump = (store as { dump?: () => MemoryData }).dump
  return dump ? memoryLinkStore(dump) : supabaseLinkStore(db)
}

// ── Memory ──────────────────────────────────────────────────────────────────

export function memoryLinkStore(data: () => MemoryData): LinkStore {
  const d = () => data()
  const now = () => d().clock().toISOString()
  const staffName = (id: string | null) => (id ? d().staff.find(s => s.userId === id)?.displayName ?? null : null)
  const view = (l: MemoryData['entryLinks'][number]): EntryLink => {
    const { key: _key, ...rest } = l
    return { ...rest, leadName: l.leadId ? d().leads.find(x => x.id === l.leadId)?.firstName ?? null : null, createdByName: staffName(l.createdBy) }
  }
  const partnerView = (p: MemoryData['partners'][number]): Partner => ({ ...p, leads: d().leads.filter(l => l.partnerId === p.id && !l.deletedAt).length })
  const audit = (actorId: string | null, entityType: string, entityId: string, action: string, before: unknown, after: unknown) =>
    d().audit.push({ id: d().audit.length + 1, actorId, entityType, entityId, action, before, after, reason: null, createdAt: now() })

  return {
    async createLink(input) {
      if (d().entryLinks.some(l => l.key === input.key)) throw new Error('qe:code_taken')
      const row = {
        id: randomUUID(), key: input.key, kind: input.kind, code: input.kind === 'campaign' ? input.key : null,
        label: input.label, prefill: input.prefill, leadId: input.leadId, createdBy: input.createdBy,
        uses: 0, maxUses: input.maxUses, expiresAt: input.expiresAt, revokedAt: null, createdAt: now(),
      }
      d().entryLinks.push(row)
      audit(input.createdBy, 'entry_link', row.id, 'created', null, { kind: row.kind, label: row.label, leadId: row.leadId })
      return view(row)
    },
    async findLink(key) {
      const l = d().entryLinks.find(x => x.key === key)
      return l ? { ...view(l), key: l.key } : null
    },
    async useLink(key, at) {
      const l = d().entryLinks.find(x => x.key === key)
      if (!l) throw new Error('qe:not_found')
      const state = linkState(l, at)
      if (state === 'active') l.uses += 1
      return { link: view(l), state }
    },
    async listLinks(filter) {
      return d().entryLinks
        .filter(l => (!filter.kind || l.kind === filter.kind) && (!filter.leadId || l.leadId === filter.leadId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(view)
    },
    async revokeLink(id, actor) {
      const l = d().entryLinks.find(x => x.id === id)
      if (!l) return null
      if (!l.revokedAt) {
        l.revokedAt = now()
        audit(actor, 'entry_link', id, 'revoked', null, null)
      }
      return view(l)
    },
    async attachLead(key, leadId) {
      const l = d().entryLinks.find(x => x.key === key)
      const lead = d().leads.find(x => x.id === leadId)
      if (!l || !lead) return
      if (l.kind === 'dm') {
        l.leadId ??= leadId
        if (!lead.ownerStaffId && l.createdBy) {
          lead.ownerStaffId = l.createdBy
          audit(null, 'lead', leadId, 'owner_from_link', null, { ownerStaffId: l.createdBy, linkId: l.id })
        }
      }
    },
    async creditPartner(leadId, code) {
      const p = d().partners.find(x => x.code === code.toUpperCase() && x.active)
      const lead = d().leads.find(x => x.id === leadId)
      if (!p || !lead || lead.partnerId) return false
      lead.partnerId = p.id
      audit(null, 'lead', leadId, 'partner_credited', null, { partnerId: p.id })
      return true
    },
    async leadPartner(leadId) {
      const pid = d().leads.find(l => l.id === leadId)?.partnerId
      const p = pid ? d().partners.find(x => x.id === pid) : undefined
      return p ? partnerView(p) : null
    },
    async partners() {
      return [...d().partners].sort((a, b) => a.name.localeCompare(b.name)).map(partnerView)
    },
    async partnerByCode(code) {
      const p = d().partners.find(x => x.code === code.toUpperCase())
      return p ? partnerView(p) : null
    },
    async createPartner(input, actor) {
      if (d().partners.some(p => p.code === input.code)) throw new Error('qe:code_taken')
      const row = { id: randomUUID(), ...input, createdAt: now() }
      d().partners.push(row)
      audit(actor, 'partner', row.id, 'created', null, input)
      return partnerView(row)
    },
    async updatePartner(id, patch, actor) {
      const p = d().partners.find(x => x.id === id)
      if (!p) return null
      if (patch.code && patch.code !== p.code && d().partners.some(x => x.code === patch.code)) throw new Error('qe:code_taken')
      const before = { ...p }
      Object.assign(p, patch)
      audit(actor, 'partner', id, 'updated', before, { ...p })
      return partnerView(p)
    },
    async commissionJobs(filter) {
      const out: CommissionJob[] = []
      for (const j of d().jobs) {
        const lead = d().leads.find(l => l.id === j.leadId)
        const p = lead?.partnerId ? d().partners.find(x => x.id === lead.partnerId) : undefined
        if (!lead || !p || (filter.partnerId && p.id !== filter.partnerId)) continue
        const option = d().quotes.find(q => q.id === j.quoteId)?.options.find(o => o.tier === j.optionTier)
        const payout = d().payouts.find(x => x.jobId === j.id)
        out.push({
          jobId: j.id, jobRef: j.ref, leadId: lead.id, leadName: lead.deletedAt ? null : lead.firstName,
          partnerId: p.id, partnerName: p.name, partnerCode: p.code, commissionType: p.commissionType, commissionValue: p.commissionValue,
          currency: j.currency, net: option?.net ?? 0, status: j.status, depositStatus: j.depositStatus, balanceStatus: j.balanceStatus,
          balancePaidAt: j.balancePaidAt,
          payout: payout ? { id: payout.id, amount: payout.amount, reference: payout.reference, paidAt: payout.paidAt, paidByName: staffName(payout.paidBy) } : null,
        })
      }
      return out.sort((a, b) => (b.balancePaidAt ?? '').localeCompare(a.balancePaidAt ?? '') || a.jobRef.localeCompare(b.jobRef))
    },
    async recordPayouts(items, reference, actor) {
      let n = 0
      for (const item of items) {
        if (d().payouts.some(x => x.jobId === item.jobId)) continue
        const job = d().jobs.find(j => j.id === item.jobId)
        const lead = job ? d().leads.find(l => l.id === job.leadId) : undefined
        if (!job || !lead?.partnerId) continue
        const row = { id: randomUUID(), partnerId: lead.partnerId, jobId: job.id, amount: item.amount, currency: job.currency, reference, paidAt: now(), paidBy: actor }
        d().payouts.push(row)
        audit(actor, 'partner_payout', row.id, 'recorded', null, { jobId: job.id, amount: item.amount, reference })
        n++
      }
      return n
    },
  }
}

// ── Supabase ────────────────────────────────────────────────────────────────

const toLink = (r: any): EntryLink & { key: string } => ({
  id: r.id, key: r.code, kind: r.kind, code: r.kind === 'campaign' ? r.code : null, label: r.label, prefill: r.prefill ?? {},
  leadId: r.lead_id, leadName: r.lead_name ?? null, createdBy: r.created_by, createdByName: r.created_by_name ?? null,
  uses: r.uses, maxUses: r.max_uses, expiresAt: r.expires_at, revokedAt: r.revoked_at, createdAt: r.created_at,
})
const publicLink = (r: any): EntryLink => {
  const { key: _key, ...rest } = toLink(r)
  return rest
}
const toPartner = (r: any): Partner => ({
  id: r.id, name: r.name, code: r.code, commissionType: r.commission_type, commissionValue: r.commission_value,
  active: r.active, createdAt: r.created_at, leads: Number(r.leads ?? 0),
})

export function supabaseLinkStore(db: SupabaseClient): LinkStore {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args)
    if (error) {
      const code = /qe:([a-z_]+)/.exec(error.message)?.[1]
      throw new Error(code ? `qe:${code}` : `${fn}: ${error.message}`)
    }
    return data as T
  }
  return {
    async createLink(input) {
      return publicLink(await rpc('qe_link_create', {
        p_kind: input.kind, p_code: input.key, p_label: input.label, p_prefill: input.prefill, p_lead: input.leadId,
        p_actor: input.createdBy, p_max_uses: input.maxUses, p_expires_at: input.expiresAt,
      }))
    },
    async findLink(key) {
      const row = await rpc<any>('qe_link_get', { p_code: key })
      return row ? toLink(row) : null
    },
    async useLink(key, at) {
      const r = await rpc<{ link: any; state: LinkState }>('qe_link_use', { p_code: key, p_now: at.toISOString() })
      return { link: publicLink(r.link), state: r.state }
    },
    async listLinks(filter) {
      return ((await rpc<any[]>('qe_link_list', { p_kind: filter.kind ?? null, p_lead: filter.leadId ?? null })) ?? []).map(publicLink)
    },
    async revokeLink(id, actor) {
      const row = await rpc<any>('qe_link_revoke', { p_id: id, p_actor: actor })
      return row ? publicLink(row) : null
    },
    async attachLead(key, leadId) {
      await rpc('qe_link_attach', { p_code: key, p_lead: leadId })
    },
    async creditPartner(leadId, code) {
      return rpc<boolean>('qe_partner_credit', { p_lead: leadId, p_code: code.toUpperCase() })
    },
    async leadPartner(leadId) {
      const { data, error } = await db.from('qe_leads').select('partner_id').eq('id', leadId).maybeSingle()
      if (error) throw new Error(`find lead partner: ${error.message}`)
      if (!data?.partner_id) return null
      return (await this.partners()).find(p => p.id === data.partner_id) ?? null
    },
    async partners() {
      return ((await rpc<any[]>('qe_partner_list', {})) ?? []).map(toPartner)
    },
    async partnerByCode(code) {
      const { data, error } = await db.from('qe_partners').select('*').eq('code', code.toUpperCase()).maybeSingle()
      if (error) throw new Error(`find partner: ${error.message}`)
      return data ? toPartner(data) : null
    },
    async createPartner(input, actor) {
      return toPartner(await rpc('qe_partner_save', { p_id: null, p: partnerRow(input), p_actor: actor }))
    },
    async updatePartner(id, patch, actor) {
      const row = await rpc<any>('qe_partner_save', { p_id: id, p: partnerRow(patch), p_actor: actor })
      return row ? toPartner(row) : null
    },
    async commissionJobs(filter) {
      const rows = (await rpc<any[]>('qe_commission_jobs', { p_partner: filter.partnerId ?? null })) ?? []
      return rows.map(r => ({
        jobId: r.job_id, jobRef: r.job_ref, leadId: r.lead_id, leadName: r.lead_name, partnerId: r.partner_id,
        partnerName: r.partner_name, partnerCode: r.partner_code, commissionType: r.commission_type, commissionValue: r.commission_value,
        currency: r.currency, net: r.net, status: r.status, depositStatus: r.deposit_status, balanceStatus: r.balance_status,
        balancePaidAt: r.balance_paid_at,
        payout: r.payout_id ? { id: r.payout_id, amount: r.payout_amount, reference: r.payout_reference, paidAt: r.payout_paid_at, paidByName: r.payout_paid_by_name } : null,
      }))
    },
    async recordPayouts(items, reference, actor) {
      return rpc<number>('qe_partner_payouts_record', { p_items: items.map(i => ({ job_id: i.jobId, amount: i.amount })), p_reference: reference, p_actor: actor })
    },
  }
}

function partnerRow(p: Partial<PartnerInput>) {
  const row: Record<string, unknown> = {}
  if (p.name !== undefined) row.name = p.name
  if (p.code !== undefined) row.code = p.code
  if (p.commissionType !== undefined) row.commission_type = p.commissionType
  if (p.commissionValue !== undefined) row.commission_value = p.commissionValue
  if (p.active !== undefined) row.active = p.active
  return row
}
