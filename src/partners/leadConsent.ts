import type { FastifyInstance } from 'fastify'
import type { KeyMode } from '../utils/partnerKeys.js'
import type { ListingStore, TextRow } from './listingStore.js'
import { fillText } from './notify.js'

// Consent for sharing a buyer's details with the partner whose listing they
// asked about (Kenya Data Protection Act). The lead form shows the wording
// from api_texts with the partner's name filled in; the exact words and the
// answer are stored per lead. /v1/leads returns only leads where the answer
// was yes and has not been withdrawn.

export const CONSENT_TEXT_KEY = 'lead_share_consent'

export type ConsentDeps = {
  listings: Pick<ListingStore, 'activeText' | 'insertConsent'>
  /** The partner behind a tour, if it is a partner listing. */
  partnerForSpace: (spaceId: string) => Promise<{ partner_id: string; mode: KeyMode; partner_name: string } | null>
  getText: (id: string) => Promise<TextRow | null>
}

export function leadConsent(deps: ConsentDeps) {
  /** What the lead form should show for this tour, or null when it is not a partner listing. */
  async function wordingFor(spaceId: string, locale = 'en') {
    const p = await deps.partnerForSpace(spaceId)
    if (!p) return null
    const t = (await deps.listings.activeText(CONSENT_TEXT_KEY, locale)) ?? (locale !== 'en' ? await deps.listings.activeText(CONSENT_TEXT_KEY, 'en') : null)
    if (!t) return null
    return { text_id: t.id, locale: t.locale, partner_name: p.partner_name, wording: fillText(t.body, { partner: p.partner_name }) }
  }

  /** Stores the answer. Returns false (and stores nothing) when the text or partner does not match. */
  async function record(leadId: string, spaceId: string, answer: { accepted: boolean; textId: string }) {
    const [p, t] = await Promise.all([deps.partnerForSpace(spaceId), deps.getText(answer.textId)])
    if (!p || !t || t.key !== CONSENT_TEXT_KEY) return false
    await deps.listings.insertConsent({
      lead_id: leadId, partner_id: p.partner_id, mode: p.mode, text_id: t.id, locale: t.locale,
      wording: fillText(t.body, { partner: p.partner_name }), accepted: answer.accepted,
    })
    return true
  }

  return { wordingFor, record }
}

export function supabaseConsentDeps(fastify: FastifyInstance, listings: ListingStore): ConsentDeps {
  const db = fastify.supabase
  return {
    listings,
    async partnerForSpace(spaceId) {
      const { data } = await db.from('api_partner_tours').select('partner_id, mode, api_partners(name, status)').eq('space_id', spaceId).maybeSingle()
      const p = (data as any)?.api_partners
      return data && p?.status === 'active' ? { partner_id: (data as any).partner_id, mode: (data as any).mode, partner_name: p.name } : null
    },
    async getText(id) {
      const { data } = await db.from('api_texts').select('id, key, locale, version, subject, body, active, created_by, created_at').eq('id', id).maybeSingle()
      return (data as TextRow) ?? null
    },
  }
}
