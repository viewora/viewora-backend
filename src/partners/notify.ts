import type { FastifyInstance } from 'fastify'
import type { ListingStore, WebhookRow } from './listingStore.js'

// Messages to partners. The wording lives in api_texts (editable in admin),
// never in code. Sending is off unless PARTNER_WEBHOOK_EMAILS=1, so nothing
// reaches a real inbox before staff switch it on.

export type SendEmail = (p: { to: string[]; subject: string; text: string }) => Promise<unknown>

/** Fills {name} placeholders; unknown names are left as they are. */
export function fillText(body: string, values: Record<string, string>): string {
  return body.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in values ? values[k] : m))
}

export function partnerNotifier(deps: {
  listings: ListingStore
  contact: (partnerId: string) => Promise<{ name: string; email: string | null } | null>
  send: SendEmail
  enabled: () => boolean
  log?: { info: Function; warn: Function }
}) {
  return {
    async webhookDisabled(w: WebhookRow) {
      if (!deps.enabled()) { deps.log?.info({ webhook: w.id }, 'webhook-disabled email not sent (PARTNER_WEBHOOK_EMAILS is off)'); return }
      const [who, text] = await Promise.all([deps.contact(w.partner_id), deps.listings.activeText('webhook_disabled_email', 'en')])
      if (!who?.email) { deps.log?.warn({ partner: w.partner_id }, 'webhook disabled: partner has no contact email'); return }
      if (!text) { deps.log?.warn({}, 'webhook disabled: no active webhook_disabled_email text'); return }
      const values = { partner: who.name, url: w.url, webhook_id: `wh_${w.id}` }
      await deps.send({ to: [who.email], subject: fillText(text.subject ?? 'Viewora webhook switched off', values), text: fillText(text.body, values) })
    },
  }
}

export function supabasePartnerContact(fastify: FastifyInstance) {
  return async (partnerId: string) => {
    const { data } = await fastify.supabase.from('api_partners').select('name, contact_email').eq('id', partnerId).maybeSingle()
    return data ? { name: (data as any).name as string, email: ((data as any).contact_email as string | null) ?? null } : null
  }
}
