// Supabase implementation of QuoteStore over the qe_* tables. Uses the
// service-role client (RLS has no policies on these tables by design).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PriceResult, RateItem, RateTable } from './engine/types.js'
import type { QuoteStore, RequestRecord } from './store.js'

const RATE_CACHE_MS = 60_000

function fail(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`quote store: ${what}: ${error.message}`)
}

function toRecord(row: any): RequestRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    moduleKey: row.module_key,
    moduleVersion: row.module_version,
    clientType: row.client_type,
    answers: row.answers?.answers ?? { details: {}, addons: {} },
    entry: row.answers?.entry ?? {},
    stepReached: row.step_reached,
    flags: row.flags ?? [],
    abVariant: row.ab_variant,
    device: row.device ?? {},
    startedAt: row.started_at,
    lastSavedAt: row.last_saved_at,
    completedAt: row.completed_at,
  }
}

export function supabaseStore(db: SupabaseClient): QuoteStore {
  let cached: { at: number; table: RateTable } | null = null

  return {
    async publishedRateTable() {
      if (cached && Date.now() - cached.at < RATE_CACHE_MS) return cached.table
      const { data: t, error } = await db.from('qe_rate_tables')
        .select('id, version, effective_from, settings').eq('status', 'published').maybeSingle()
      fail(error, 'load rate table')
      if (!t) return null
      const { data: rows, error: itemsErr } = await db.from('qe_rate_items').select('*').eq('rate_table_id', t.id)
      fail(itemsErr, 'load rate items')
      const items: Record<string, RateItem> = {}
      for (const r of rows ?? []) {
        items[r.key] = {
          key: r.key, category: r.category, label: r.label, unit: r.unit,
          low: r.amount_low, high: r.amount_high, use: r.use_value,
          ...(r.industry ? { industry: r.industry } : {}),
          ...(r.custom ? { custom: true } : {}),
          ...(r.scenes !== null ? { scenes: r.scenes } : {}),
          ...(r.tiers ? { tiers: r.tiers } : {}),
          ...(r.meta && Object.keys(r.meta).length ? { meta: r.meta } : {}),
        }
      }
      const table: RateTable = { id: t.id, version: t.version, effectiveFrom: t.effective_from, settings: t.settings, items }
      cached = { at: Date.now(), table }
      return table
    },

    async consentText(locale) {
      const { data, error } = await db.from('qe_consent_texts').select('id, body')
        .eq('locale', locale).order('created_at', { ascending: false }).limit(1).maybeSingle()
      fail(error, 'load consent text')
      return data
    },

    async createRequest(input, tokenHash) {
      const { data, error } = await db.from('qe_quote_requests').insert({
        module_key: input.moduleKey,
        module_version: input.moduleVersion,
        client_type: input.clientType,
        answers: { answers: { details: {}, addons: {} }, entry: input.entry },
        step_reached: input.stepReached,
        resume_token_hash: tokenHash,
        ab_variant: input.abVariant,
        device: input.device,
      }).select().single()
      fail(error, 'create request')
      return toRecord(data)
    },

    async findRequest(tokenHash) {
      const { data, error } = await db.from('qe_quote_requests').select('*').eq('resume_token_hash', tokenHash).maybeSingle()
      fail(error, 'find request')
      return data ? toRecord(data) : null
    },

    async updateRequest(id, patch) {
      const { data: current, error: readErr } = await db.from('qe_quote_requests').select('answers').eq('id', id).single()
      fail(readErr, 'read request')
      const row: Record<string, unknown> = { last_saved_at: new Date().toISOString() }
      if (patch.leadId !== undefined) row.lead_id = patch.leadId
      if (patch.moduleKey !== undefined) row.module_key = patch.moduleKey
      if (patch.moduleVersion !== undefined) row.module_version = patch.moduleVersion
      if (patch.clientType !== undefined) row.client_type = patch.clientType
      if (patch.stepReached !== undefined) row.step_reached = patch.stepReached
      if (patch.flags !== undefined) row.flags = patch.flags
      if (patch.completedAt !== undefined) row.completed_at = patch.completedAt
      if (patch.answers !== undefined || patch.entry !== undefined) {
        row.answers = {
          answers: patch.answers ?? current!.answers?.answers,
          entry: patch.entry ?? current!.answers?.entry ?? {},
        }
      }
      const { data, error } = await db.from('qe_quote_requests').update(row).eq('id', id).select().single()
      fail(error, 'update request')
      return toRecord(data)
    },

    async upsertLead(input) {
      const { data: existing, error: findErr } = await db.from('qe_leads')
        .select('id, first_name, email, consent_whatsapp, consent_email')
        .eq('whatsapp_e164', input.whatsappE164).is('deleted_at', null).maybeSingle()
      fail(findErr, 'find lead')
      const consentAt = input.consentWhatsapp || input.consentEmail ? new Date().toISOString() : null
      if (existing) {
        const patch: Record<string, unknown> = { last_activity_at: new Date().toISOString() }
        if (!existing.first_name) patch.first_name = input.firstName
        if (!existing.email && input.email) patch.email = input.email
        if (input.consentWhatsapp && !existing.consent_whatsapp) Object.assign(patch, { consent_whatsapp: true, consent_at: consentAt, consent_text_id: input.consentTextId })
        if (input.consentEmail && !existing.consent_email) Object.assign(patch, { consent_email: true, consent_at: consentAt, consent_text_id: input.consentTextId })
        const { error } = await db.from('qe_leads').update(patch).eq('id', existing.id)
        fail(error, 'update lead')
        return { id: existing.id, created: false }
      }
      const { data, error } = await db.from('qe_leads').insert({
        first_name: input.firstName,
        whatsapp_e164: input.whatsappE164,
        email: input.email,
        consent_whatsapp: input.consentWhatsapp,
        consent_email: input.consentEmail,
        consent_at: consentAt,
        consent_text_id: input.consentTextId,
        source: input.source,
        utm: input.utm,
      }).select('id').single()
      fail(error, 'create lead')
      return { id: data!.id, created: true }
    },

    async getLead(id) {
      const { data, error } = await db.from('qe_leads').select('id, first_name, whatsapp_e164, email').eq('id', id).maybeSingle()
      fail(error, 'get lead')
      return data ? { id: data.id, firstName: data.first_name, whatsappE164: data.whatsapp_e164, email: data.email } : null
    },

    async saveQuote(requestId, result: PriceResult, opts) {
      const { data: quote, error } = await db.from('qe_quotes').insert({
        request_id: requestId,
        rate_table_id: result.rateTableId,
        result_mode: result.mode,
        currency: result.currency,
        fx_rate: result.fxRate ?? null,
        vat_charged: result.vat.charged,
        vat_rate_bp: result.vat.rateBp,
        deposit_bp: opts.depositBp,
        valid_until: opts.validUntil,
        // A price the visitor saw counts as sent; a custom draft waits for staff
        status: result.mode === 'custom' ? 'draft' : 'sent',
        sent_at: result.mode === 'custom' ? null : new Date().toISOString(),
        engine_trace: result,
      }).select('id').single()
      fail(error, 'save quote')
      for (const option of result.options) {
        const { data: opt, error: optErr } = await db.from('qe_quote_options').insert({
          quote_id: quote!.id, tier: option.tier, subtotal: option.subtotal, discount: option.discount,
          net: option.net, vat: option.vat, total: option.total, total_high: option.totalHigh ?? null,
          deposit: option.deposit, selected: option.tier === 'standard' || result.options.length === 1,
        }).select('id').single()
        fail(optErr, 'save option')
        const { error: linesErr } = await db.from('qe_quote_lines').insert(option.lines.map((l, i) => ({
          option_id: opt!.id, position: i, rate_item_key: l.key, kind: l.kind, label: l.label,
          quantity: l.qty, unit_price: l.unit, amount: l.amount, tbc: !!l.tbc, note: l.note ?? null,
        })))
        fail(linesErr, 'save lines')
      }
      return quote!.id
    },

    async latestQuote(requestId) {
      const { data, error } = await db.from('qe_quotes').select('engine_trace')
        .eq('request_id', requestId).order('created_at', { ascending: false }).limit(1).maybeSingle()
      fail(error, 'latest quote')
      return (data?.engine_trace as PriceResult) ?? null
    },
  }
}
