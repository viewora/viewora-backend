// Storage for the quote form. Routes only talk to this interface, so tests
// and local runs use the in-memory store while production uses Supabase
// (qe_* tables from migration-quote-engine-001.sql).

import type { MemoryAccounts } from './accountStore.js'
import type { MemoryDeliveries } from './deliveryStore.js'
import { randomUUID } from 'node:crypto'
import type { ClientType, PriceResult, RateTable } from './engine/types.js'
import { docFromEngine, type QuoteDoc } from './desk.js'
import { DEFAULT_BOOKING, type BookingSettings, type JobCost, type JobRecord, type PaymentRecord } from './jobs.js'
import { DEFAULT_MESSAGING, type MessagingSettings, type SequenceKey } from './followups.js'
import type { EntryLink, Partner } from './links.js'

export interface StoredAnswers {
  details: Record<string, string | number | boolean>
  addons: Record<string, number>
  location?: { town?: string; lat?: number; lng?: number }
  timing?: 'this_week' | 'this_month' | 'planning'
  note?: string
  currency?: 'KES' | 'USD'   // the visitor asked for dollars (Phase 5c)
}

export interface EntryInfo {
  source?: string
  utm?: Record<string, string>
  partnerCode?: string
  linkKey?: string        // the /q/:code link it came from (stored key: a hash for DM links)
}

export interface RequestRecord {
  id: string
  leadId: string | null
  moduleKey: string | null
  moduleVersion: number | null
  clientType: ClientType | null
  answers: StoredAnswers
  stepReached: number
  flags: string[]
  entry: EntryInfo
  abVariant: string | null
  device: Record<string, string>
  startedAt: string
  lastSavedAt: string
  completedAt: string | null
}

export type NewRequest = Pick<RequestRecord, 'moduleKey' | 'moduleVersion' | 'clientType' | 'entry' | 'abVariant' | 'device' | 'stepReached'>

export interface LeadInput {
  firstName: string
  whatsappE164: string
  email: string | null
  consentWhatsapp: boolean
  consentEmail: boolean
  consentTextId: string | null
  source: string | null
  utm: Record<string, string>
}

export interface LeadView {
  id: string
  firstName: string | null
  whatsappE164: string | null
  email: string | null
}

export interface ConsentText { id: string; body: string }

export interface MessageTemplate { version: number; subject: string | null; body: string; waTemplateName?: string | null }

export interface MessageRecord {
  leadId: string
  quoteId?: string | null
  channel: 'whatsapp' | 'email' | 'staff_alert'
  templateKey: string
  templateVersion: number | null
  renderedBody: string | null
  status: 'queued' | 'sent' | 'failed' | 'skipped'
  skipReason?: string
  error?: string
  sentAt?: string
  // Follow-ups (migration 006)
  sequenceId?: string | null
  sequenceStep?: string | null
  needsStaff?: boolean                    // a WhatsApp to-do: staff press send themselves
}

export interface QuoteStore {
  publishedRateTable(): Promise<RateTable | null>
  consentText(locale: string): Promise<ConsentText | null>
  createRequest(input: NewRequest, tokenHash: string): Promise<RequestRecord>
  findRequest(tokenHash: string): Promise<RequestRecord | null>
  updateRequest(id: string, patch: Partial<Omit<RequestRecord, 'id' | 'startedAt'>>): Promise<RequestRecord>
  // Matches on WhatsApp number. An existing lead is never overwritten by the
  // public form: only empty fields are filled and consent can only be added.
  upsertLead(input: LeadInput): Promise<{ id: string; created: boolean }>
  getLead(id: string): Promise<LeadView | null>
  saveQuote(requestId: string, result: PriceResult, opts: { validUntil: string; depositBp: number }): Promise<string>
  latestQuote(requestId: string): Promise<PriceResult | null>
  // Editable message wording (qe_message_templates), newest active version
  messageTemplate(key: string, channel: 'email' | 'whatsapp', locale?: string): Promise<MessageTemplate | null>
  // Staff who asked for new-lead emails
  alertRecipients(): Promise<string[]>
  recordMessage(message: MessageRecord): Promise<string>
  // Another "finish your quote" link for the same request (reminders)
  addResumeToken(requestId: string, tokenHash: string, expiresAt: string): Promise<void>
}

export type MemoryLead = LeadInput & {
  id: string; stage: string; createdAt: string; lastActivityAt: string; consentAt: string | null; deletedAt: string | null
  ownerStaffId: string | null; optedOutAt: string | null; partnerId: string | null
  userId?: string | null                  // the Viewora account it belongs to (Phase 5b)
}

export interface MemoryStaff {
  userId: string; displayName: string; role: 'admin' | 'sales' | 'viewer'; discountLimitBp: number; email: string | null; active: boolean
}

// A quote document plus the engine output it came from (null for staff edits)
export type MemoryQuote = QuoteDoc & { id: string; createdAt: string; updatedAt: string; trace: PriceResult | null }

export interface MemoryLink {
  id: string; quoteId: string; tokenHash: string; channel: 'link' | 'whatsapp' | 'email'; createdBy: string | null
  createdAt: string; expiresAt: string; revokedAt: string | null; firstViewedAt: string | null; lastViewedAt: string | null; views: number
}

export interface MemoryRateTable extends RateTable {
  status: 'draft' | 'published' | 'archived'; notes: string | null; publishedAt: string | null; publishedBy: string | null; createdAt: string
}

export interface MemoryAudit {
  id: number; actorId: string | null; entityType: string; entityId: string; action: string
  before: unknown; after: unknown; reason: string | null; createdAt: string
}

// ── In-memory store (tests and local runs) ──────────────────────────────────
// One live state object, shared with the memory admin and desk stores so
// every view sees the same leads and quotes, as the database would.

export interface MemoryData {
  requests: RequestRecord[]
  leads: MemoryLead[]
  quotes: MemoryQuote[]
  links: MemoryLink[]
  messages: Array<MessageRecord & { id: string; createdAt: string }>
  notes: Array<{ id: string; leadId: string; authorId: string | null; body: string; createdAt: string }>
  audit: MemoryAudit[]
  staff: MemoryStaff[]
  rateTables: MemoryRateTable[]
  // Phase 3: deposits and jobs (migration 005)
  payments: Array<Omit<PaymentRecord, 'recordedByName'> & { recordedBy: string | null; raw: unknown; lastCheckedAt?: string }>
  jobs: Array<Omit<JobRecord, 'costs' | 'payments' | 'costsTotal' | 'assignedStaffName' | 'leadName' | 'requestId' | 'quoteVersion'> & { optionTier: string }>
  jobCosts: Array<JobCost & { jobId: string; createdBy: string | null }>
  invoices: Array<{ id: string; jobId: string; paymentId: string; status: 'pending' | 'issued' | 'failed' | 'not_configured'; provider: string | null; externalRef: string | null; error: string | null }>
  settings: { booking: BookingSettings; messaging: MessagingSettings }
  // Phase 4: follow-ups and editable wording (migration 006)
  sequences: Array<{
    id: string; leadId: string; key: SequenceKey; subjectId: string | null; status: 'active' | 'stopped' | 'completed'
    stopReason: string | null; nextStep: number; nextRunAt: string | null; startedAt: string; createdAt: string; updatedAt: string; stoppedAt: string | null
  }>
  templates: Array<{ key: string; channel: 'whatsapp' | 'email'; version: number; subject: string | null; body: string; updatedBy: string | null; updatedAt: string }>
  messageTasks: Record<string, { doneBy: string | null; doneAt: string | null }>
  // Phase 4b: /q/:code links, partners and payouts (migration 007)
  entryLinks: Array<Omit<EntryLink, 'leadName' | 'createdByName'> & { key: string }>
  partners: Array<Omit<Partner, 'leads'>>
  payouts: Array<{ id: string; partnerId: string; jobId: string; amount: number; currency: 'KES' | 'USD'; reference: string | null; paidAt: string; paidBy: string | null }>
  // Phase 5b: orders from a signed-in account (migration 009)
  accounts: MemoryAccounts
  // Phase 5: tours handed to the client's account (migration 010)
  deliveries: MemoryDeliveries
  // The memory stores' clock (tests and the dev server move it); real time otherwise
  clock: () => Date
}

export function memoryStore(seed: {
  rateTable: RateTable
  consent?: ConsentText
  templates?: Record<string, MessageTemplate>   // keyed "key:channel"
  recipients?: string[]
  staff?: MemoryStaff[]
  clock?: () => Date
  profiles?: MemoryAccounts['profiles']
  tours?: MemoryDeliveries['tours']
}): QuoteStore & { dump(): MemoryData } {
  const clock = seed.clock ?? (() => new Date())
  const now = () => clock().toISOString()
  const state: MemoryData = {
    requests: [], leads: [], quotes: [], links: [], messages: [], notes: [], audit: [],
    payments: [], jobs: [], jobCosts: [], invoices: [],
    settings: { booking: structuredClone(DEFAULT_BOOKING), messaging: structuredClone(DEFAULT_MESSAGING) },
    sequences: [], messageTasks: {}, clock, entryLinks: [], partners: [], payouts: [],
    accounts: { requests: {}, profiles: structuredClone(seed.profiles ?? {}) },
    deliveries: { tours: structuredClone(seed.tours ?? []), rows: [], usage: {} },
    templates: Object.entries(seed.templates ?? {}).map(([k, t]) => {
      const [key, channel] = k.split(':') as [string, 'whatsapp' | 'email']
      return { key, channel, version: t.version, subject: t.subject, body: t.body, updatedBy: null, updatedAt: now() }
    }),
    staff: structuredClone(seed.staff ?? []),
    // Ids are uuids, as in the database (the seed file's own id is a label)
    rateTables: [{ ...structuredClone(seed.rateTable), id: randomUUID(), status: 'published', notes: null, publishedAt: now(), publishedBy: null, createdAt: now() }],
  }
  const byHash = new Map<string, string>()
  const request = (id: string) => state.requests.find(r => r.id === id)!

  return {
    async publishedRateTable() {
      const t = state.rateTables.find(x => x.status === 'published')
      if (!t) return null
      const { status: _s, notes: _n, publishedAt: _p, publishedBy: _b, createdAt: _c, ...table } = structuredClone(t)
      return table
    },
    async consentText() { return seed.consent ?? null },
    async createRequest(input, tokenHash) {
      const record: RequestRecord = {
        id: randomUUID(), leadId: null, answers: { details: {}, addons: {} }, flags: [],
        startedAt: now(), lastSavedAt: now(), completedAt: null, ...input,
      }
      state.requests.push(record)
      byHash.set(tokenHash, record.id)
      return structuredClone(record)
    },
    async findRequest(tokenHash) {
      const id = byHash.get(tokenHash)
      return id ? structuredClone(request(id)) : null
    },
    async updateRequest(id, patch) {
      Object.assign(request(id), structuredClone(patch), { lastSavedAt: now() })
      return structuredClone(request(id))
    },
    async upsertLead(input) {
      const existing = state.leads.find(l => l.whatsappE164 === input.whatsappE164 && !l.deletedAt)
      if (existing) {
        existing.firstName ||= input.firstName
        existing.email ||= input.email
        existing.consentWhatsapp ||= input.consentWhatsapp
        existing.consentEmail ||= input.consentEmail
        existing.lastActivityAt = now()
        return { id: existing.id, created: false }
      }
      const id = randomUUID()
      const consentAt = input.consentWhatsapp || input.consentEmail ? now() : null
      state.leads.push({ ...input, id, stage: 'new', createdAt: now(), lastActivityAt: now(), consentAt, deletedAt: null, ownerStaffId: null, optedOutAt: null, partnerId: null })
      return { id, created: true }
    },
    async getLead(id) {
      const l = state.leads.find(x => x.id === id)
      return l ? { id, firstName: l.firstName, whatsappE164: l.whatsappE164, email: l.email } : null
    },
    async saveQuote(requestId, result, opts) {
      const id = randomUUID()
      const version = Math.max(0, ...state.quotes.filter(q => q.requestId === requestId).map(q => q.version)) + 1
      // A price the visitor saw counts as sent; a custom draft waits for staff
      const doc = docFromEngine(result, {
        requestId, leadId: request(requestId).leadId, version, depositBp: opts.depositBp, validUntil: opts.validUntil,
        status: result.mode === 'custom' ? 'draft' : 'sent',
      })
      state.quotes.push({ ...doc, id, createdAt: now(), updatedAt: now(), sentAt: doc.status === 'sent' ? now() : null, trace: structuredClone(result) })
      return id
    },
    async latestQuote(requestId) {
      const q = state.quotes.filter(x => x.requestId === requestId && x.trace).at(-1)
      return q ? structuredClone(q.trace) : null
    },
    async messageTemplate(key, channel) {
      const t = state.templates.filter(x => x.key === key && x.channel === channel).sort((a, b) => b.version - a.version)[0]
      return t ? { version: t.version, subject: t.subject, body: t.body } : null
    },
    async alertRecipients() { return seed.recipients ?? [] },
    async recordMessage(message) {
      const id = randomUUID()
      state.messages.push({ ...structuredClone(message), id, createdAt: now() })
      return id
    },
    async addResumeToken(requestId, tokenHash) { byHash.set(tokenHash, requestId) },
    dump: () => state,
  }
}
