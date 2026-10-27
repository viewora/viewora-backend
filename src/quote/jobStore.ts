// Storage for deposits, balances and jobs. Production calls the SQL
// functions in migration-quote-engine-005.sql (each one transaction);
// tests and local runs use the memory version over the same state as
// memoryStore and memoryDeskStore.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { DeskError } from './deskStore.js'
import type { MemoryData } from './store.js'
import type {
  BookingSettings, JobCost, JobPatch, JobRecord, JobStatus, ManualChannel, PaymentRecord, SettleResult, ShootWindow,
} from './jobs.js'

export interface NewPayment {
  kind: 'deposit' | 'balance'
  quoteId: string
  jobId?: string
  tier?: string
  amount: number
  reference: string
  linkId?: string | null
  email?: string | null
  live: boolean
}

export interface PaidFacts {
  amount: number          // Paystack subunits
  currency: string
  channel: string | null
  paidAt: string | null
  raw: unknown
}

export interface JobFilter {
  status?: JobStatus | 'open'
  staffId?: string
  from?: string
  to?: string
  leadId?: string
  q?: string
  limit?: number
  offset?: number
}

export interface JobStore {
  // Checks amount, tier and quote state again; keeps an email given at pay time
  createPayment(p: NewPayment, today: string): Promise<string>
  setPaymentUrl(reference: string, url: string): Promise<void>
  payment(reference: string): Promise<PaymentRecord | null>
  // Records a verified payment exactly once (see SettleResult)
  settle(reference: string, paid: PaidFacts): Promise<SettleResult>
  failPayment(reference: string, status: 'failed' | 'abandoned', reason: string): Promise<void>
  paymentChecked(reference: string): Promise<void>
  // References of Paystack payments still waiting, oldest first
  pendingPayments(minAgeS: number, maxAgeS: number, limit: number): Promise<string[]>
  manualBalance(jobId: string, actorId: string, channel: ManualChannel, reference: string, note: string): Promise<SettleResult>
  updateInvoice(id: string, patch: { status: 'issued' | 'failed' | 'not_configured'; provider?: string | null; externalRef?: string | null; error?: string | null }): Promise<void>

  job(id: string): Promise<JobRecord | null>
  jobForRequest(requestId: string): Promise<JobRecord | null>
  jobs(filter: JobFilter): Promise<{ total: number; rows: JobRecord[] }>
  updateJob(id: string, patch: JobPatch, actorId: string): Promise<JobRecord>
  // The client picks a slot; refused when full or already confirmed
  requestDate(id: string, date: string, window: ShootWindow, perSlot: number): Promise<JobRecord>
  addCost(jobId: string, label: string, amount: number, actorId: string): Promise<JobCost>
  deleteCost(jobId: string, costId: string, actorId: string): Promise<void>
  bookingCounts(from: string, to: string): Promise<Array<{ date: string; window: ShootWindow; n: number }>>
  bookingSettings(): Promise<BookingSettings | null>
  setBookingSettings(value: BookingSettings, actorId: string): Promise<void>
}

// ── Memory ──────────────────────────────────────────────────────────────────

const OPEN_QUOTE = ['draft', 'needs_approval', 'sent', 'viewed']

export function memoryJobStore(data: () => MemoryData): JobStore {
  const d = () => data()
  const now = () => new Date().toISOString()
  const audit = (actorId: string | null, entityType: string, entityId: string, action: string, before: unknown, after: unknown, reason: string | null = null) => {
    const list = d().audit
    list.push({ id: list.length + 1, actorId, entityType, entityId, action, before: structuredClone(before ?? null), after: structuredClone(after ?? null), reason, createdAt: now() })
  }
  const staffName = (id: string | null) => d().staff.find(s => s.userId === id)?.displayName ?? null
  const pay = (reference: string) => d().payments.find(p => p.reference === reference)
  const payOut = (p: MemoryData['payments'][number]): PaymentRecord => {
    const { recordedBy, raw: _raw, lastCheckedAt: _l, ...rest } = p
    return structuredClone({ ...rest, recordedByName: staffName(recordedBy) })
  }
  const requestOf = (quoteId: string) => {
    const q = d().quotes.find(x => x.id === quoteId)!
    return { q, r: d().requests.find(x => x.id === q.requestId)! }
  }
  const liveJobFor = (requestId: string) => d().jobs.find(j => j.status !== 'cancelled' && requestOf(j.quoteId).r.id === requestId)
  const jobOut = (j: MemoryData['jobs'][number], full = true): JobRecord => {
    const { optionTier: _t, ...rest } = j
    const { q } = requestOf(j.quoteId)
    const costs = d().jobCosts.filter(c => c.jobId === j.id)
    const out: JobRecord = {
      ...structuredClone(rest), requestId: q.requestId, quoteVersion: q.version,
      assignedStaffName: staffName(j.assignedStaffId), leadName: d().leads.find(l => l.id === j.leadId)?.firstName ?? null,
      costsTotal: costs.reduce((s, c) => s + c.amount, 0),
    }
    if (full) {
      out.costs = costs.map(({ jobId: _j, createdBy, ...c }) => ({ ...c, createdByName: staffName(createdBy) }))
      out.payments = d().payments.filter(p => p.jobId === j.id && p.status === 'success').map(payOut)
    }
    return out
  }
  const jobRow = (id: string) => {
    const j = d().jobs.find(x => x.id === id)
    if (!j) throw new DeskError('not_found')
    return j
  }
  const invoice = (jobId: string, paymentId: string) => {
    const id = randomUUID()
    d().invoices.push({ id, jobId, paymentId, status: 'pending', provider: null, externalRef: null, error: null })
    return id
  }
  const moveLead = (leadId: string, to: string, unless: string[], actorId: string | null, reason: string) => {
    const l = d().leads.find(x => x.id === leadId)
    if (!l || unless.includes(l.stage)) return
    audit(actorId, 'lead', l.id, 'stage_changed', { stage: l.stage }, { stage: to }, reason)
    l.stage = to
    l.lastActivityAt = now()
  }

  return {
    async createPayment(p, today) {
      const q = d().quotes.find(x => x.id === p.quoteId)
      if (!q) throw new DeskError('not_found')
      let tier: string
      let jobId: string | null = null
      if (p.kind === 'deposit') {
        if (!['sent', 'viewed'].includes(q.status)) throw new DeskError('not_payable')
        if (q.validUntil && q.validUntil < today) throw new DeskError('expired')
        if (liveJobFor(q.requestId)) throw new DeskError('already_booked')
        const o = q.options.find(x => x.tier === p.tier)
        if (!o) throw new DeskError('no_option')
        if (q.mode === 'range' || o.lines.some(l => l.tbc)) throw new DeskError('not_final')
        if (o.deposit !== p.amount || o.deposit <= 0) throw new DeskError('amount_mismatch')
        tier = o.tier
      } else {
        const j = d().jobs.find(x => x.id === p.jobId && x.quoteId === q.id)
        if (!j) throw new DeskError('not_found')
        if (j.balanceStatus !== 'pending' || j.status === 'cancelled') throw new DeskError('balance_closed')
        if (j.balanceAmount !== p.amount || j.balanceAmount <= 0) throw new DeskError('amount_mismatch')
        tier = j.tier ?? j.optionTier
        jobId = j.id
      }
      if (p.email) {
        const lead = d().leads.find(l => l.id === requestOf(q.id).r.leadId)
        if (lead && !lead.email) lead.email = p.email
      }
      if (pay(p.reference)) throw new Error('duplicate reference')
      const id = randomUUID()
      d().payments.push({
        id, reference: p.reference, kind: p.kind, provider: 'paystack', status: 'initialized', amount: p.amount, currency: q.currency,
        tier, channel: null, paidAt: null, failureReason: null, authorizationUrl: null, live: p.live, quoteId: q.id, jobId,
        linkId: p.linkId ?? null, checks: 0, note: null, recordedBy: null, raw: null, createdAt: now(),
      })
      return id
    },
    async setPaymentUrl(reference, url) { const p = pay(reference); if (p) p.authorizationUrl = url },
    async payment(reference) { const p = pay(reference); return p ? payOut(p) : null },

    async settle(reference, paid) {
      const p = pay(reference)
      if (!p) throw new DeskError('not_found')
      const base = { kind: p.kind, paymentId: p.id, quoteId: p.quoteId }
      if (p.status === 'success') return { outcome: 'already', ...base, jobId: p.jobId }
      const unit = p.currency === 'KES' ? 100 : 1
      if (paid.amount !== p.amount * unit || paid.currency.toUpperCase() !== p.currency) {
        Object.assign(p, { status: 'failed', failureReason: 'amount_mismatch', raw: paid.raw })
        audit(null, 'payment', p.id, 'payment_mismatch', { amount: p.amount, currency: p.currency }, { paid: paid.amount, currency: paid.currency })
        return { outcome: 'mismatch', ...base }
      }
      const paidAt = paid.paidAt ?? now()
      Object.assign(p, { status: 'success', channel: paid.channel, paidAt, raw: paid.raw, failureReason: null })
      const { q, r } = requestOf(p.quoteId)
      const leadId = r.leadId

      if (p.kind === 'deposit') {
        const existing = liveJobFor(q.requestId)
        if (existing) {
          p.jobId = existing.id
          p.note = 'Second deposit for a job that was already booked: refund it'
          audit(null, 'job', existing.id, 'duplicate_deposit', null, { reference, amount: p.amount })
          return { outcome: 'duplicate', ...base, jobId: existing.id, leadId }
        }
        const o = q.options.find(x => x.tier === p.tier)!
        q.options.forEach(x => { x.selected = x.tier === p.tier })
        const before = q.status
        q.status = 'accepted'
        q.updatedAt = now()
        for (const other of d().quotes) {
          if (other.requestId === q.requestId && other.id !== q.id && OPEN_QUOTE.includes(other.status)) other.status = 'superseded'
        }
        audit(null, 'quote', q.id, 'accepted', { status: before }, { status: 'accepted', tier: p.tier, version: q.version }, 'deposit paid')
        if (leadId) moveLead(leadId, 'booked', ['booked', 'delivered', 'paid'], null, 'deposit paid')
        const id = randomUUID()
        const balance = o.total - p.amount
        const industry = r.flags.find(f => f.startsWith('industry:'))?.slice(9) ?? r.moduleKey
        d().jobs.push({
          id, ref: `J-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`, quoteId: q.id, leadId: leadId!, tier: p.tier, optionTier: o.tier,
          status: 'booked', price: o.total, currency: q.currency,
          depositAmount: p.amount, depositStatus: 'paid', depositPaidAt: paidAt,
          balanceAmount: balance, balanceStatus: balance <= 0 ? 'paid' : 'pending', balancePaidAt: balance <= 0 ? paidAt : null,
          shootDate: null, shootWindow: null, shootDateStatus: 'none',
          locationText: r.answers.location?.town ?? null, locationLat: r.answers.location?.lat ?? null, locationLng: r.answers.location?.lng ?? null,
          assignedStaffId: null, hours: { travel: 0, shoot: 0, edit: 0, admin: 0 }, deliveredAt: null, tourUrl: null, notes: null,
          industry, clientType: r.clientType, source: d().leads.find(l => l.id === leadId)?.source ?? null,
          createdAt: now(), updatedAt: now(), closedAt: null,
        })
        p.jobId = id
        audit(null, 'job', id, 'created', null, jobOut(d().jobs.at(-1)!, false), 'deposit paid')
        return { outcome: 'settled', ...base, jobId: id, leadId, invoiceId: invoice(id, p.id) }
      }

      const j = jobRow(p.jobId!)
      if (j.balanceStatus !== 'pending') {
        p.note = 'Balance was already settled: refund it'
        audit(null, 'job', j.id, 'duplicate_balance', null, { reference, amount: p.amount })
        return { outcome: 'duplicate', ...base, jobId: j.id, leadId }
      }
      Object.assign(j, { balanceStatus: 'paid', balancePaidAt: paidAt, updatedAt: now() })
      if (leadId) moveLead(leadId, 'paid', ['lost'], null, 'balance paid')
      audit(null, 'job', j.id, 'balance_paid', null, { reference, amount: p.amount })
      return { outcome: 'settled', ...base, jobId: j.id, leadId, invoiceId: invoice(j.id, p.id) }
    },

    async failPayment(reference, status, reason) {
      const p = pay(reference)
      if (p && p.status === 'initialized') Object.assign(p, { status, failureReason: reason })
    },
    async paymentChecked(reference) {
      const p = pay(reference)
      if (p) { p.checks += 1; p.lastCheckedAt = now() }
    },
    async pendingPayments(minAgeS, maxAgeS, limit) {
      const t = Date.now()
      return d().payments
        .filter(p => p.status === 'initialized' && p.provider === 'paystack')
        .filter(p => { const age = (t - Date.parse(p.createdAt)) / 1000; return age > minAgeS && age < maxAgeS })
        .filter(p => !p.lastCheckedAt || t - Date.parse(p.lastCheckedAt) > 300_000)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit).map(p => p.reference)
    },
    async manualBalance(jobId, actorId, channel, reference, note) {
      const j = jobRow(jobId)
      if (j.balanceStatus !== 'pending') throw new DeskError('balance_closed')
      const id = randomUUID()
      const { q, r } = requestOf(j.quoteId)
      d().payments.push({
        id, reference: `manual_${randomUUID().replace(/-/g, '')}`, kind: 'balance', provider: 'manual', status: 'success', amount: j.balanceAmount,
        currency: j.currency, tier: j.tier, channel, paidAt: now(), failureReason: null, authorizationUrl: null, live: false,
        quoteId: q.id, jobId, linkId: null, checks: 0, note: [reference, note].filter(Boolean).join(' · ') || null, recordedBy: actorId, raw: null, createdAt: now(),
      })
      Object.assign(j, { balanceStatus: 'paid', balancePaidAt: now(), updatedAt: now() })
      if (r.leadId) moveLead(r.leadId, 'paid', ['lost'], actorId, 'balance paid')
      audit(actorId, 'job', jobId, 'balance_paid', null, { channel, amount: j.balanceAmount, reference }, note || null)
      return { outcome: 'settled', kind: 'balance', paymentId: id, jobId, quoteId: q.id, leadId: r.leadId, invoiceId: invoice(jobId, id) }
    },
    async updateInvoice(id, patch) {
      const inv = d().invoices.find(x => x.id === id)
      if (inv) Object.assign(inv, { provider: null, externalRef: null, error: null, ...patch })
    },

    async job(id) { const j = d().jobs.find(x => x.id === id); return j ? jobOut(j) : null },
    async jobForRequest(requestId) { const j = liveJobFor(requestId); return j ? jobOut(j) : null },
    async jobs(f) {
      const q = f.q?.toLowerCase()
      const rows = d().jobs.filter(j =>
        (!f.status || j.status === f.status || (f.status === 'open' && !['closed', 'cancelled'].includes(j.status)))
        && (!f.staffId || j.assignedStaffId === f.staffId)
        && (!f.from || (j.shootDate !== null && j.shootDate >= f.from))
        && (!f.to || (j.shootDate !== null && j.shootDate <= f.to))
        && (!f.leadId || j.leadId === f.leadId)
        && (!q || j.ref.toLowerCase().includes(q) || (d().leads.find(l => l.id === j.leadId)?.firstName ?? '').toLowerCase().includes(q)))
      // Unscheduled first (they need a date), then by shoot date, newest first within
      rows.sort((a, b) => (a.shootDate === b.shootDate ? b.createdAt.localeCompare(a.createdAt) : a.shootDate === null ? -1 : b.shootDate === null ? 1 : a.shootDate.localeCompare(b.shootDate)))
      const offset = f.offset ?? 0
      return { total: rows.length, rows: rows.slice(offset, offset + (f.limit ?? 50)).map(j => jobOut(j, false)) }
    },
    async updateJob(id, patch, actorId) {
      const j = jobRow(id)
      if (patch.assignedStaffId && !d().staff.find(s => s.userId === patch.assignedStaffId && s.active)) throw new DeskError('owner_not_staff')
      const before = jobOut(j, false)
      const { hours, ...rest } = patch
      if (rest.status === 'closed' && j.status !== 'closed') j.closedAt = now()
      else if (rest.status && rest.status !== 'closed') j.closedAt = null
      if (rest.status === 'delivered' && j.status !== 'delivered') {
        const l = d().leads.find(x => x.id === j.leadId)
        if (l && ['booked', 'quoted', 'contacted', 'new'].includes(l.stage)) {
          l.stage = 'delivered'
          audit(actorId, 'lead', l.id, 'stage_changed', null, { stage: 'delivered' }, 'job delivered')
        }
      }
      Object.assign(j, rest, { hours: { ...j.hours, ...hours }, updatedAt: now() })
      audit(actorId, 'job', id, 'updated', before, jobOut(j, false))
      return jobOut(j)
    },
    async requestDate(id, date, window, perSlot) {
      const j = jobRow(id)
      if (j.shootDateStatus === 'confirmed' || !['booked', 'scheduled'].includes(j.status)) throw new DeskError('date_locked')
      const n = d().jobs.filter(x => x.id !== id && x.status !== 'cancelled' && x.shootDate === date && x.shootWindow === window).length
      if (n >= perSlot) throw new DeskError('slot_full')
      const before = { shootDate: j.shootDate, shootWindow: j.shootWindow }
      Object.assign(j, { shootDate: date, shootWindow: window, shootDateStatus: 'requested', updatedAt: now() })
      audit(null, 'job', id, 'date_requested', before, { shootDate: date, shootWindow: window }, 'picked by the client')
      return jobOut(j)
    },
    async addCost(jobId, label, amount, actorId) {
      jobRow(jobId)
      const cost = { id: randomUUID(), jobId, label, amount, createdAt: now(), createdBy: actorId }
      d().jobCosts.push(cost)
      audit(actorId, 'job', jobId, 'cost_added', null, { label, amount })
      return { id: cost.id, label, amount, createdAt: cost.createdAt }
    },
    async deleteCost(jobId, costId, actorId) {
      const i = d().jobCosts.findIndex(c => c.id === costId && c.jobId === jobId)
      if (i < 0) throw new DeskError('not_found')
      const [c] = d().jobCosts.splice(i, 1)
      audit(actorId, 'job', jobId, 'cost_removed', { label: c.label, amount: c.amount }, null)
    },
    async bookingCounts(from, to) {
      const counts = new Map<string, { date: string; window: ShootWindow; n: number }>()
      for (const j of d().jobs) {
        if (j.status === 'cancelled' || !j.shootDate || !j.shootWindow || j.shootDate < from || j.shootDate > to) continue
        const key = `${j.shootDate}:${j.shootWindow}`
        const c = counts.get(key) ?? { date: j.shootDate, window: j.shootWindow, n: 0 }
        c.n += 1
        counts.set(key, c)
      }
      return [...counts.values()]
    },
    async bookingSettings() { return structuredClone(d().settings.booking) },
    async setBookingSettings(value, actorId) {
      audit(actorId, 'settings', 'booking', 'updated', d().settings.booking, value)
      d().settings.booking = structuredClone(value)
    },
  }
}

// ── Supabase ────────────────────────────────────────────────────────────────

function rethrow(fn: string, error: { message: string }): never {
  const code = /qe:([a-z_]+)/.exec(error.message)?.[1]
  if (code) throw new DeskError(code)
  throw new Error(`quote jobs: ${fn}: ${error.message}`)
}

// NUMERIC hours come back as numbers from jsonb; keep them numbers
const normaliseJob = (raw: any): JobRecord | null => (raw ? { ...raw, hours: Object.fromEntries(Object.entries(raw.hours ?? {}).map(([k, v]) => [k, Number(v)])) } : null)

export function supabaseJobStore(db: SupabaseClient): JobStore {
  const call = async <T>(fn: string, args?: Record<string, unknown>): Promise<T> => {
    const { data, error } = await db.rpc(fn, args)
    if (error) rethrow(fn, error)
    return data as T
  }
  return {
    createPayment: (p, today) => call('qe_pay_create', { p, p_today: today }),
    setPaymentUrl: (reference, url) => call('qe_pay_set_url', { p_ref: reference, p_url: url }),
    payment: async reference => (await call<PaymentRecord | null>('qe_pay_get', { p_ref: reference })) ?? null,
    settle: (reference, paid) => call('qe_pay_settle', {
      p_ref: reference, p_amount: paid.amount, p_currency: paid.currency, p_channel: paid.channel, p_paid_at: paid.paidAt, p_raw: paid.raw ?? null,
    }),
    failPayment: (reference, status, reason) => call('qe_pay_fail', { p_ref: reference, p_status: status, p_reason: reason }),
    paymentChecked: reference => call('qe_pay_checked', { p_ref: reference }),
    pendingPayments: (minAgeS, maxAgeS, limit) => call('qe_pay_pending', { p_min_age_s: minAgeS, p_max_age_s: maxAgeS, p_limit: limit }),
    manualBalance: (jobId, actorId, channel, reference, note) =>
      call('qe_pay_manual_balance', { p_job: jobId, p_actor: actorId, p_channel: channel, p_reference: reference, p_note: note }),
    updateInvoice: (id, patch) => call('qe_invoice_update', {
      p_id: id, p_status: patch.status, p_provider: patch.provider ?? null, p_external: patch.externalRef ?? null, p_error: patch.error ?? null,
    }),

    job: async id => normaliseJob(await call('qe_job_get', { p_id: id })),
    jobForRequest: async requestId => normaliseJob(await call('qe_job_for_request', { p_request: requestId })),
    async jobs(f) {
      const r = await call<{ total: number; rows: any[] }>('qe_job_list', { p: f })
      return { total: r.total, rows: r.rows.map(x => normaliseJob(x)!) }
    },
    updateJob: async (id, patch, actorId) => normaliseJob(await call('qe_job_update', { p_id: id, p: patch, p_actor: actorId }))!,
    requestDate: async (id, date, window, perSlot) =>
      normaliseJob(await call('qe_job_request_date', { p_id: id, p_date: date, p_window: window, p_per_slot: perSlot }))!,
    addCost: (jobId, label, amount, actorId) => call('qe_job_add_cost', { p_job: jobId, p_label: label, p_amount: amount, p_actor: actorId }),
    deleteCost: (jobId, costId, actorId) => call('qe_job_delete_cost', { p_job: jobId, p_cost: costId, p_actor: actorId }),
    bookingCounts: (from, to) => call('qe_booking_counts', { p_from: from, p_to: to }),
    bookingSettings: async () => (await call<BookingSettings | null>('qe_settings_get', { p_key: 'booking' })) ?? null,
    setBookingSettings: (value, actorId) => call('qe_settings_set', { p_key: 'booking', p_value: value, p_actor: actorId }),
  }
}
