// Storage for the quote form. Routes only talk to this interface, so tests
// and local runs use the in-memory store while production uses Supabase
// (qe_* tables from migration-quote-engine-001.sql).

import { randomUUID } from 'node:crypto'
import type { ClientType, PriceResult, RateTable } from './engine/types.js'

export interface StoredAnswers {
  details: Record<string, string | number | boolean>
  addons: Record<string, number>
  location?: { town?: string; lat?: number; lng?: number }
  timing?: 'this_week' | 'this_month' | 'planning'
  note?: string
}

export interface EntryInfo {
  source?: string
  utm?: Record<string, string>
  partnerCode?: string
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
}

// ── In-memory store (tests and local runs) ──────────────────────────────────

export function memoryStore(seed: { rateTable: RateTable; consent?: ConsentText }): QuoteStore & { dump(): unknown } {
  const requests = new Map<string, RequestRecord>()
  const byHash = new Map<string, string>()
  const leads = new Map<string, LeadInput & { id: string }>()
  const quotes: Array<{ id: string; requestId: string; result: PriceResult }> = []
  const now = () => new Date().toISOString()

  return {
    async publishedRateTable() { return seed.rateTable },
    async consentText() { return seed.consent ?? null },
    async createRequest(input, tokenHash) {
      const record: RequestRecord = {
        id: randomUUID(), leadId: null, answers: { details: {}, addons: {} }, flags: [],
        startedAt: now(), lastSavedAt: now(), completedAt: null, ...input,
      }
      requests.set(record.id, record)
      byHash.set(tokenHash, record.id)
      return structuredClone(record)
    },
    async findRequest(tokenHash) {
      const id = byHash.get(tokenHash)
      return id ? structuredClone(requests.get(id)!) : null
    },
    async updateRequest(id, patch) {
      const next = { ...requests.get(id)!, ...structuredClone(patch), lastSavedAt: now() }
      requests.set(id, next)
      return structuredClone(next)
    },
    async upsertLead(input) {
      const existing = [...leads.values()].find(l => l.whatsappE164 === input.whatsappE164)
      if (existing) {
        existing.firstName ||= input.firstName
        existing.email ||= input.email
        existing.consentWhatsapp ||= input.consentWhatsapp
        existing.consentEmail ||= input.consentEmail
        return { id: existing.id, created: false }
      }
      const id = randomUUID()
      leads.set(id, { ...input, id })
      return { id, created: true }
    },
    async getLead(id) {
      const l = leads.get(id)
      return l ? { id, firstName: l.firstName, whatsappE164: l.whatsappE164, email: l.email } : null
    },
    async saveQuote(requestId, result) {
      const id = randomUUID()
      quotes.push({ id, requestId, result: structuredClone(result) })
      return id
    },
    async latestQuote(requestId) {
      const q = quotes.filter(x => x.requestId === requestId).pop()
      return q ? structuredClone(q.result) : null
    },
    dump: () => ({ requests: [...requests.values()], leads: [...leads.values()], quotes }),
  }
}
