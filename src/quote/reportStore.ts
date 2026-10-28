// Where report rows come from. One row per form started in the period; the
// Supabase version is one read-only SQL function (migration 008) so the
// numbers are worked out from the same tables the admin shows.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MemoryData } from './store.js'
import type { ReportRow } from './reports.js'
import { industryHint } from './industries.js'

export interface ReportStore {
  rows(fromIso: string, toIso: string): Promise<ReportRow[]>
}

export function reportStoreFor(store: object, db: SupabaseClient): ReportStore {
  const dump = (store as { dump?: () => MemoryData }).dump
  return dump ? memoryReportStore(dump) : supabaseReportStore(db)
}

const minutesBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000))

export function memoryReportStore(data: () => MemoryData): ReportStore {
  return {
    async rows(fromIso, toIso) {
      const d = data()
      return d.requests
        .filter(r => r.startedAt >= fromIso && r.startedAt < toIso && (r.moduleKey || industryHint(r.flags)))
        .map(r => {
          const lead = r.leadId ? d.leads.find(l => l.id === r.leadId) : undefined
          const quotes = d.quotes.filter(q => q.requestId === r.id)
          const quoteIds = new Set(quotes.map(q => q.id))
          const job = d.jobs.find(j => quoteIds.has(j.quoteId) && j.status !== 'cancelled')
          const option = job ? quotes.find(q => q.id === job.quoteId)?.options.find(o => o.tier === job.optionTier) : undefined

          let firstStaff: string | null = null
          const leadId = r.leadId
          if (r.completedAt && leadId) {
            const touches = [
              ...d.audit.filter(a => a.actorId && ((a.entityType === 'lead' && a.entityId === leadId) || (a.entityType === 'quote' && quoteIds.has(a.entityId)))).map(a => a.createdAt),
              ...d.notes.filter(n => n.authorId && n.leadId === leadId).map(n => n.createdAt),
              ...d.messages.filter(m => m.leadId === leadId && d.messageTasks[m.id]?.doneBy).map(m => d.messageTasks[m.id].doneAt!),
            ].filter(t => t && t >= r.completedAt!).sort()
            firstStaff = touches[0] ?? null
          }
          return {
            requestId: r.id,
            startedAt: r.startedAt,
            industry: industryHint(r.flags) ?? r.moduleKey!,
            source: r.entry.source ?? lead?.source ?? null,
            stepReached: r.stepReached,
            completed: !!r.completedAt,
            quoted: quotes.some(q => q.sentAt),
            booked: !!job,
            paid: job?.balanceStatus === 'paid',
            jobValue: option?.net ?? null,
            currency: job?.currency ?? null,
            firstStaffMinutes: firstStaff ? minutesBetween(r.completedAt!, firstStaff) : null,
            abVariant: r.abVariant,
          }
        })
    },
  }
}

export function supabaseReportStore(db: SupabaseClient): ReportStore {
  return {
    async rows(fromIso, toIso) {
      const { data, error } = await db.rpc('qe_report_rows', { p_from: fromIso, p_to: toIso })
      if (error) throw new Error(`qe_report_rows: ${error.message}`)
      return ((data as any[]) ?? []).map(r => ({
        requestId: r.request_id,
        startedAt: r.started_at,
        industry: r.industry,
        source: r.source ?? null,
        stepReached: r.step_reached,
        completed: r.completed,
        quoted: r.quoted,
        booked: r.booked,
        paid: r.paid,
        jobValue: r.job_value ?? null,
        currency: r.currency ?? null,
        firstStaffMinutes: r.first_staff_minutes ?? null,
        abVariant: r.ab_variant ?? null,
      }))
    },
  }
}
