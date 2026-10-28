// Storage for follow-ups, WhatsApp to-dos, editable wording and messaging
// settings. Production uses the qe_* tables and functions from migration
// 006; tests and local runs use the shared in-memory state.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MemoryData } from './store.js'
import { DEFAULT_MESSAGING, STOPPED_BY, type Channel, type FollowupCtx, type FollowupLead, type MessagingSettings, type SequenceKey } from './followups.js'

export interface SequenceRow {
  id: string
  leadId: string
  key: SequenceKey
  subjectId: string | null
  status: 'active' | 'stopped' | 'completed'
  stopReason: string | null
  nextStep: number
  nextRunAt: string | null
  startedAt: string
  stoppedAt: string | null
}

export interface TaskRow {
  id: string
  leadId: string
  leadName: string | null
  whatsappE164: string | null
  templateKey: string
  body: string
  sequenceKey: string | null
  sequenceStep: string | null
  quoteId: string | null
  createdAt: string
}

export interface TemplateVersion {
  key: string
  channel: Channel
  version: number
  subject: string | null
  body: string
  updatedBy: string | null
  updatedByName: string | null
  updatedAt: string
}

export interface FollowupStore {
  lead(id: string): Promise<FollowupLead | null>
  latestRequest(leadId: string): Promise<NonNullable<FollowupCtx['request']> | null>
  // Replaces an active sequence of the same kind for the lead
  start(input: { leadId: string; key: SequenceKey; subjectId: string | null; nextStep: number; nextRunAt: string; startedAt: string }): Promise<string>
  // Pushes an active sequence's next run (the visitor saved another step)
  touch(leadId: string, key: SequenceKey, nextRunAt: string): Promise<void>
  // Stops active sequences and drops their unsent to-dos; how many stopped
  stop(leadId: string, reason: string, actorId: string | null): Promise<number>
  claimDue(now: Date, limit: number): Promise<SequenceRow[]>
  advance(id: string, patch: { nextStep: number; nextRunAt: string | null; status?: 'completed' | 'stopped'; stopReason?: string }): Promise<void>
  // Automated messages to the lead since `since` that count toward the cap
  weekCount(leadId: string, since: string, exemptSteps: string[]): Promise<{ count: number; oldestAt: string | null }>
  sequences(leadId: string): Promise<SequenceRow[]>
  tasks(leadId?: string): Promise<TaskRow[]>
  finishTask(id: string, staffId: string, outcome: 'sent' | 'skipped', at: string): Promise<boolean>
  expireTasks(createdBefore: string): Promise<number>
  templates(): Promise<TemplateVersion[]>        // every version, newest first
  saveTemplate(key: string, channel: Channel, subject: string | null, body: string, actorId: string): Promise<number>
  settings(): Promise<MessagingSettings>
  saveSettings(value: MessagingSettings, actorId: string): Promise<void>
  optOut(leadId: string, actorId: string | null, via: string): Promise<boolean>
  // An inbound WhatsApp from this number stops the lead's follow-ups
  replied(e164: string): Promise<string | null>
}

const keysFor = (reason: string): SequenceKey[] | null => {
  const k = STOPPED_BY[reason] ?? 'all'
  return k === 'all' ? null : k
}

// The memory store's follow-ups when routes run over memory (tests, the
// dev server); Supabase otherwise
export function followupStoreFor(store: object, db: SupabaseClient): FollowupStore {
  const dump = (store as { dump?: () => MemoryData }).dump
  return dump ? memoryFollowupStore(dump) : supabaseFollowupStore(db)
}

// ── Memory ──────────────────────────────────────────────────────────────────

export function memoryFollowupStore(data: () => MemoryData): FollowupStore {
  const d = () => data()
  const now = () => data().clock().toISOString()
  const audit = (actorId: string | null, entityType: string, entityId: string, action: string, before: unknown, after: unknown) => {
    const list = d().audit
    list.push({ id: list.length + 1, actorId, entityType, entityId, action, before: structuredClone(before ?? null), after: structuredClone(after ?? null), reason: null, createdAt: now() })
  }
  const out = (s: MemoryData['sequences'][number]): SequenceRow => {
    const { createdAt: _c, updatedAt: _u, ...row } = structuredClone(s)
    return row
  }
  const stop = (leadId: string, reason: string, actorId: string | null) => {
    const keys = keysFor(reason)
    const hit = d().sequences.filter(s => s.leadId === leadId && s.status === 'active' && (!keys || keys.includes(s.key)))
    for (const s of hit) Object.assign(s, { status: 'stopped', stopReason: reason, stoppedAt: now(), updatedAt: now() })
    const ids = new Set(hit.map(s => s.id))
    for (const m of d().messages) {
      if (m.sequenceId && ids.has(m.sequenceId) && m.status === 'queued') Object.assign(m, { status: 'skipped', skipReason: 'stopped' })
    }
    if (hit.length) audit(actorId, 'lead', leadId, 'followups_stopped', null, { reason, count: hit.length })
    return hit.length
  }
  return {
    async lead(id) {
      const l = d().leads.find(x => x.id === id && !x.deletedAt)
      return l ? {
        id: l.id, firstName: l.firstName, whatsappE164: l.whatsappE164, email: l.email,
        consentWhatsapp: l.consentWhatsapp, consentEmail: l.consentEmail, optedOutAt: l.optedOutAt, stage: l.stage,
      } : null
    },
    async latestRequest(leadId) {
      const r = d().requests.filter(x => x.leadId === leadId).sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt))[0]
      return r ? { id: r.id, stepReached: r.stepReached, completedAt: r.completedAt, lastSavedAt: r.lastSavedAt } : null
    },
    async start(input) {
      for (const s of d().sequences) {
        if (s.leadId === input.leadId && s.key === input.key && s.status === 'active') Object.assign(s, { status: 'stopped', stopReason: 'restarted', stoppedAt: now(), updatedAt: now() })
      }
      const id = randomUUID()
      d().sequences.push({ id, ...input, status: 'active', stopReason: null, stoppedAt: null, createdAt: now(), updatedAt: now() })
      return id
    },
    async touch(leadId, key, nextRunAt) {
      const s = d().sequences.find(x => x.leadId === leadId && x.key === key && x.status === 'active')
      if (s) Object.assign(s, { nextRunAt, updatedAt: now() })
    },
    async stop(leadId, reason, actorId) { return stop(leadId, reason, actorId) },
    async claimDue(at, limit) {
      const due = d().sequences.filter(s => s.status === 'active' && s.nextRunAt && Date.parse(s.nextRunAt) <= at.getTime())
        .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!)).slice(0, limit)
      for (const s of due) s.nextRunAt = new Date(at.getTime() + 5 * 60_000).toISOString()
      return due.map(out)
    },
    async advance(id, patch) {
      const s = d().sequences.find(x => x.id === id)
      if (!s) return
      Object.assign(s, { nextStep: patch.nextStep, nextRunAt: patch.nextRunAt, updatedAt: now() })
      if (patch.status) Object.assign(s, { status: patch.status, stopReason: patch.stopReason ?? null, stoppedAt: patch.status === 'stopped' ? now() : null })
    },
    async weekCount(leadId, since, exempt) {
      const counted = d().messages.filter(m => m.leadId === leadId && m.sequenceId && m.createdAt >= since
        && (m.status === 'sent' || m.status === 'queued') && !exempt.includes(m.sequenceStep ?? ''))
      return { count: counted.length, oldestAt: counted.map(m => m.createdAt).sort()[0] ?? null }
    },
    async sequences(leadId) {
      return d().sequences.filter(s => s.leadId === leadId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(out)
    },
    async tasks(leadId) {
      return d().messages.filter(m => m.status === 'queued' && m.needsStaff && (!leadId || m.leadId === leadId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(m => {
          const l = d().leads.find(x => x.id === m.leadId)
          return {
            id: m.id, leadId: m.leadId, leadName: l?.firstName ?? null, whatsappE164: l?.whatsappE164 ?? null,
            templateKey: m.templateKey, body: m.renderedBody ?? '', quoteId: m.quoteId ?? null, createdAt: m.createdAt, sequenceStep: m.sequenceStep ?? null,
            sequenceKey: d().sequences.find(s => s.id === m.sequenceId)?.key ?? null,
          }
        })
    },
    async finishTask(id, staffId, outcome, at) {
      const m = d().messages.find(x => x.id === id && x.status === 'queued' && x.needsStaff)
      if (!m) return false
      Object.assign(m, outcome === 'sent' ? { status: 'sent', sentAt: at, skipReason: 'click_to_chat' } : { status: 'skipped', skipReason: 'staff_skipped' })
      d().messageTasks[id] = { doneBy: staffId, doneAt: at }
      return true
    },
    async expireTasks(before) {
      const old = d().messages.filter(m => m.status === 'queued' && m.needsStaff && m.createdAt < before)
      for (const m of old) Object.assign(m, { status: 'skipped', skipReason: 'not_sent_in_time' })
      return old.length
    },
    async templates() {
      return d().templates.slice().sort((a, b) => a.key.localeCompare(b.key) || a.channel.localeCompare(b.channel) || b.version - a.version)
        .map(t => ({ ...structuredClone(t), updatedByName: d().staff.find(s => s.userId === t.updatedBy)?.displayName ?? null }))
    },
    async saveTemplate(key, channel, subject, body, actorId) {
      const prev = d().templates.filter(t => t.key === key && t.channel === channel).sort((a, b) => b.version - a.version)[0]
      const version = (prev?.version ?? 0) + 1
      d().templates.push({ key, channel, version, subject, body, updatedBy: actorId, updatedAt: now() })
      audit(actorId, 'template', `${key}:${channel}`, 'saved', prev ? { version: prev.version, subject: prev.subject, body: prev.body } : null, { version, subject, body })
      return version
    },
    async settings() { return structuredClone(d().settings.messaging) },
    async saveSettings(value, actorId) {
      audit(actorId, 'settings', 'messaging', 'updated', d().settings.messaging, value)
      d().settings.messaging = structuredClone(value)
    },
    async optOut(leadId, actorId, via) {
      const l = d().leads.find(x => x.id === leadId && !x.deletedAt)
      if (!l) return false
      if (!l.optedOutAt) {
        Object.assign(l, { optedOutAt: now(), consentWhatsapp: false, consentEmail: false })
        audit(actorId, 'lead', leadId, 'opted_out', null, { via })
      }
      stop(leadId, 'opted_out', actorId)
      return true
    },
    async replied(e164) {
      const l = d().leads.find(x => x.whatsappE164 === e164 && !x.deletedAt)
      if (!l) return null
      l.lastActivityAt = now()
      stop(l.id, 'replied', null)
      return l.id
    },
  }
}

// ── Supabase ────────────────────────────────────────────────────────────────

export function supabaseFollowupStore(db: SupabaseClient): FollowupStore {
  const fail = (error: { message: string } | null, what: string) => {
    if (error) throw new Error(`quote followups: ${what}: ${error.message}`)
  }
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args)
    fail(error, fn)
    return data as T
  }
  const row = (s: any): SequenceRow => ({
    id: s.id, leadId: s.lead_id, key: s.sequence_key, subjectId: s.subject_id, status: s.status, stopReason: s.stop_reason,
    nextStep: s.next_step, nextRunAt: s.next_run_at, startedAt: s.started_at, stoppedAt: s.stopped_at,
  })
  return {
    async lead(id) {
      const { data, error } = await db.from('qe_leads')
        .select('id, first_name, whatsapp_e164, email, consent_whatsapp, consent_email, opted_out_at, stage')
        .eq('id', id).is('deleted_at', null).maybeSingle()
      fail(error, 'lead')
      return data ? {
        id: data.id, firstName: data.first_name, whatsappE164: data.whatsapp_e164, email: data.email,
        consentWhatsapp: data.consent_whatsapp, consentEmail: data.consent_email, optedOutAt: data.opted_out_at, stage: data.stage,
      } : null
    },
    async latestRequest(leadId) {
      const { data, error } = await db.from('qe_quote_requests').select('id, step_reached, completed_at, last_saved_at')
        .eq('lead_id', leadId).order('last_saved_at', { ascending: false }).limit(1).maybeSingle()
      fail(error, 'latest request')
      return data ? { id: data.id, stepReached: data.step_reached, completedAt: data.completed_at, lastSavedAt: data.last_saved_at } : null
    },
    start: i => call('qe_fu_start', { p_lead: i.leadId, p_key: i.key, p_subject: i.subjectId, p_step: i.nextStep, p_run: i.nextRunAt, p_started: i.startedAt }),
    async touch(leadId, key, nextRunAt) {
      const { error } = await db.from('qe_sequences').update({ next_run_at: nextRunAt, updated_at: new Date().toISOString() })
        .eq('lead_id', leadId).eq('sequence_key', key).eq('status', 'active')
      fail(error, 'touch')
    },
    stop: (leadId, reason, actorId) => call('qe_fu_stop', { p_lead: leadId, p_reason: reason, p_keys: keysFor(reason), p_actor: actorId }),
    async claimDue(now, limit) {
      return ((await call<any[]>('qe_fu_claim', { p_now: now.toISOString(), p_limit: limit })) ?? []).map(row)
    },
    async advance(id, patch) {
      const update: Record<string, unknown> = { next_step: patch.nextStep, next_run_at: patch.nextRunAt, updated_at: new Date().toISOString() }
      if (patch.status) Object.assign(update, { status: patch.status, stop_reason: patch.stopReason ?? null, stopped_at: patch.status === 'stopped' ? new Date().toISOString() : null })
      const { error } = await db.from('qe_sequences').update(update).eq('id', id)
      fail(error, 'advance')
    },
    async weekCount(leadId, since, exempt) {
      let q = db.from('qe_messages').select('created_at').eq('lead_id', leadId).not('sequence_id', 'is', null)
        .gte('created_at', since).in('status', ['sent', 'queued']).order('created_at', { ascending: true })
      if (exempt.length) q = q.not('sequence_step', 'in', `(${exempt.join(',')})`)
      const { data, error } = await q
      fail(error, 'week count')
      return { count: data?.length ?? 0, oldestAt: data?.[0]?.created_at ?? null }
    },
    async sequences(leadId) {
      const { data, error } = await db.from('qe_sequences').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(50)
      fail(error, 'sequences')
      return (data ?? []).map(row)
    },
    async tasks(leadId) {
      let q = db.from('qe_messages')
        .select('id, lead_id, template_key, rendered_body, quote_id, created_at, sequence_step, qe_leads(first_name, whatsapp_e164), qe_sequences(sequence_key)')
        .eq('status', 'queued').eq('needs_staff', true).order('created_at', { ascending: true }).limit(200)
      if (leadId) q = q.eq('lead_id', leadId)
      const { data, error } = await q
      fail(error, 'tasks')
      return (data ?? []).map((m: any) => ({
        id: m.id, leadId: m.lead_id, leadName: m.qe_leads?.first_name ?? null, whatsappE164: m.qe_leads?.whatsapp_e164 ?? null,
        templateKey: m.template_key, body: m.rendered_body ?? '', quoteId: m.quote_id, createdAt: m.created_at, sequenceStep: m.sequence_step,
        sequenceKey: m.qe_sequences?.sequence_key ?? null,
      }))
    },
    async finishTask(id, staffId, outcome, at) {
      const patch = outcome === 'sent'
        ? { status: 'sent', sent_at: at, skip_reason: 'click_to_chat', done_by: staffId, done_at: at }
        : { status: 'skipped', skip_reason: 'staff_skipped', done_by: staffId, done_at: at }
      const { data, error } = await db.from('qe_messages').update(patch).eq('id', id).eq('status', 'queued').eq('needs_staff', true).select('id')
      fail(error, 'finish task')
      return (data?.length ?? 0) > 0
    },
    async expireTasks(before) {
      const { data, error } = await db.from('qe_messages').update({ status: 'skipped', skip_reason: 'not_sent_in_time' })
        .eq('status', 'queued').eq('needs_staff', true).lt('created_at', before).select('id')
      fail(error, 'expire tasks')
      return data?.length ?? 0
    },
    async templates() {
      const { data, error } = await db.from('qe_message_templates')
        .select('key, channel, version, subject, body, updated_by, updated_at, qe_staff(display_name)')
        .eq('locale', 'en').order('key').order('channel').order('version', { ascending: false })
      fail(error, 'templates')
      return (data ?? []).map((t: any) => ({
        key: t.key, channel: t.channel, version: t.version, subject: t.subject, body: t.body,
        updatedBy: t.updated_by, updatedByName: t.qe_staff?.display_name ?? null, updatedAt: t.updated_at,
      }))
    },
    saveTemplate: (key, channel, subject, body, actorId) => call('qe_tpl_save', { p_key: key, p_channel: channel, p_subject: subject, p_body: body, p_actor: actorId }),
    async settings() {
      const value = await call<Partial<MessagingSettings> | null>('qe_settings_get', { p_key: 'messaging' })
      return { ...DEFAULT_MESSAGING, ...(value ?? {}) }
    },
    saveSettings: (value, actorId) => call('qe_settings_set', { p_key: 'messaging', p_value: value, p_actor: actorId }),
    optOut: (leadId, actorId, via) => call('qe_fu_opt_out', { p_lead: leadId, p_actor: actorId, p_via: via }),
    replied: async e164 => (await call<string | null>('qe_fu_replied', { p_e164: e164 })) ?? null,
  }
}
