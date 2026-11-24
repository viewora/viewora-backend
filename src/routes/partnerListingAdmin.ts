import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { auditLog } from './admin.js'
import type { ListingService } from '../partners/listingService.js'
import type { ListingStore } from '../partners/listingStore.js'
import type { PartnerStore } from '../partners/store.js'

// Staff tools for the listing platform, under /admin/partners/ops (the
// ADMIN_SECRET guard comes from the parent plugin): the moderation queue,
// the dead-letter lists for webhooks, media and imports, the editable
// wording (consent text, partner emails) and consent withdrawal.

export type PartnerListingAdminOptions = { service: ListingService; listings: ListingStore; partners: PartnerStore }

/** Fixed, partner-readable rejection codes (strategy doc, section 8). */
export const REJECTION_CODES = [
  'MISSING_REQUIRED_FIELD', 'LOW_QUALITY_IMAGES', 'IMAGES_NOT_OF_LISTING', 'DUPLICATE_LISTING', 'MISLEADING_PRICE',
  'CONTACT_DETAILS_IN_TEXT', 'PROHIBITED_CONTENT', 'UNVERIFIED_PARTNER', 'UNAVAILABLE_INVENTORY',
] as const

const refParams = z.object({ refId: z.string().uuid() })
const idParams = z.object({ id: z.string().uuid() })
const rejectBody = z.object({
  reasons: z.array(z.object({
    code: z.enum(REJECTION_CODES),
    message: z.string().trim().min(1).max(300),
    field: z.string().trim().max(60).optional(),
  }).strict()).min(1).max(10),
}).strict()

const textBody = z.object({
  key: z.enum(['lead_share_consent', 'webhook_disabled_email']),
  locale: z.string().regex(/^[a-z]{2}$/).default('en'),
  subject: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(1).max(4000),
}).strict()
const leadParams = z.object({ leadId: z.string().uuid() })

const staffId = (request: any) => String(request.headers['x-admin-id'] ?? 'staff').slice(0, 120)
const send = (reply: FastifyReply, r: { status: number; body: any }) =>
  r.status >= 400 ? reply.code(r.status).send({ statusMessage: r.body?.error?.message ?? 'Failed', code: r.body?.error?.code }) : reply.code(r.status).send(r.body)

export default async function partnerListingAdmin(fastify: FastifyInstance, opts: PartnerListingAdminOptions) {
  const { service, listings } = opts

  // Oldest first: the target is a decision within 4 working hours.
  fastify.get('/moderation', async (_request, reply) => {
    const rows = await listings.moderationQueue(100)
    const items = await service.outMany(rows.map(r => ({ ref: r.ref, state: r })))
    return reply.send({
      items: rows.map((r, i) => ({
        ref_id: r.tour_ref_id,
        partner_id: r.partner_id,
        partner_name: r.partner_name,
        mode: r.mode,
        waiting_since: r.updated_at,
        reasons: r.moderation_reasons,
        listing: items[i],
        // A held change: what the partner wants the listing to become.
        pending_change: r.pending_listing ? { price: r.pending_listing.price ?? null, title: r.pending_listing.title, availability: r.pending_listing.availability } : null,
      })),
      rejection_codes: REJECTION_CODES,
    })
  })

  fastify.post('/moderation/:refId/approve', async (request, reply) => {
    const p = parseWithSchema(reply, refParams, request.params)
    if (!p) return
    const r = await service.approve(p.refId, staffId(request))
    if (r.status < 400) await auditLog(fastify, request, 'partner.listing.approve', 'api_listing', p.refId)
    return send(reply, r.status < 400 ? { status: 200, body: { ok: true, listing: r.body?.listing } } : r)
  })

  fastify.post('/moderation/:refId/reject', async (request, reply) => {
    const p = parseWithSchema(reply, refParams, request.params)
    if (!p) return
    const b = parseWithSchema(reply, rejectBody, request.body)
    if (!b) return
    const r = await service.reject(p.refId, staffId(request), b.reasons)
    if (r.status < 400) await auditLog(fastify, request, 'partner.listing.reject', 'api_listing', p.refId, { codes: b.reasons.map(x => x.code) })
    return send(reply, r)
  })

  // ── dead letters ─────────────────────────────────────────────────────────
  fastify.get('/dead-letters', async (_request, reply) => {
    const [deliveries, media, imports] = await Promise.all([
      listings.deliveries({ status: 'dead', limit: 100 }),
      listings.failedMedia(100),
      listings.failedImports(50),
    ])
    const hooks = new Map<string, any>()
    for (const d of deliveries) if (!hooks.has(d.webhook_id)) hooks.set(d.webhook_id, await listings.getWebhook(d.webhook_id))
    const events = new Map((await Promise.all([...new Set(deliveries.map(d => d.event_id))].map(id => listings.getEvent(id)))).flatMap(e => e ? [[e.id, e] as const] : []))
    return reply.send({
      deliveries: deliveries.map(d => ({
        ...d, event_type: events.get(d.event_id)?.event_type ?? null,
        webhook_url: hooks.get(d.webhook_id)?.url ?? null, webhook_status: hooks.get(d.webhook_id)?.status ?? null,
      })),
      media,
      imports: imports.map(i => ({ ...i, items: undefined })),
    })
  })

  fastify.post('/dead-letters/deliveries/:id/retry', async (request, reply) => {
    const p = parseWithSchema(reply, idParams, request.params)
    if (!p) return
    await listings.updateDelivery(p.id, { status: 'pending', attempts: 0, next_attempt_at: new Date().toISOString(), locked_until: null })
    await auditLog(fastify, request, 'partner.delivery.retry', 'api_webhook_delivery', p.id)
    return reply.send({ ok: true })
  })

  fastify.post('/dead-letters/deliveries/:id/discard', async (request, reply) => {
    const p = parseWithSchema(reply, idParams, request.params)
    if (!p) return
    await listings.updateDelivery(p.id, { status: 'discarded', locked_until: null })
    await auditLog(fastify, request, 'partner.delivery.discard', 'api_webhook_delivery', p.id)
    return reply.send({ ok: true })
  })

  fastify.post('/dead-letters/media/:id/retry', async (request, reply) => {
    const p = parseWithSchema(reply, idParams, request.params)
    if (!p) return
    await listings.updateMedia(p.id, { status: 'pending', attempts: 0, next_attempt_at: new Date().toISOString(), error_code: null, error_message: null })
    await auditLog(fastify, request, 'partner.media.retry', 'api_listing_media', p.id)
    return reply.send({ ok: true })
  })

  // A partner's listings and webhooks, for the partner page.
  fastify.get('/partners/:id/listings', async (request, reply) => {
    const p = parseWithSchema(reply, idParams, request.params)
    if (!p) return
    const q = z.object({ mode: z.enum(['test', 'live']).default('live') }).safeParse(request.query ?? {})
    const mode = q.success ? q.data.mode : 'live'
    const rows = await listings.listStates({ partnerId: p.id, mode, sort: '-updated_at', limit: 100 })
    return reply.send({ listings: await service.outMany(rows.map(r => ({ ref: r.ref, state: r }))) })
  })

  fastify.get('/partners/:id/webhooks', async (request, reply) => {
    const p = parseWithSchema(reply, idParams, request.params)
    if (!p) return
    const out = []
    for (const mode of ['live', 'test'] as const) {
      for (const w of await listings.listWebhooks(p.id, mode)) {
        const recent = await listings.deliveries({ webhookId: w.id, limit: 20 })
        out.push({ id: w.id, mode, url: w.url, events: w.events, status: w.status, disabled_reason: w.disabled_reason, failing_since: w.failing_since,
          recent: { succeeded: recent.filter(d => d.status === 'succeeded').length, pending: recent.filter(d => d.status === 'pending').length, dead: recent.filter(d => d.status === 'dead').length } })
      }
    }
    return reply.send({ webhooks: out })
  })

  // ── wording: consent text and partner emails (versioned; never hardcoded) ──
  fastify.get('/texts', async (_request, reply) => {
    return reply.send({ texts: await listings.listTexts(), placeholders: { lead_share_consent: ['{partner}'], webhook_disabled_email: ['{partner}', '{url}', '{webhook_id}'] } })
  })

  fastify.post('/texts', async (request, reply) => {
    const b = parseWithSchema(reply, textBody, request.body)
    if (!b) return
    if (b.key === 'lead_share_consent' && !b.body.includes('{partner}')) {
      return reply.code(400).send({ statusMessage: 'The consent text must name the partner: include {partner}.' })
    }
    const t = await listings.saveText({ key: b.key, locale: b.locale, subject: b.subject ?? null, body: b.body, created_by: staffId(request) })
    await auditLog(fastify, request, 'partner.text.save', 'api_text', t.id, { key: t.key, locale: t.locale, version: t.version })
    return reply.code(201).send({ text: t })
  })

  // A buyer asked to stop sharing: the partner no longer receives this lead.
  fastify.post('/consents/:leadId/withdraw', async (request, reply) => {
    const p = parseWithSchema(reply, leadParams, request.params)
    if (!p) return
    const done = await listings.withdrawConsent(p.leadId, new Date().toISOString())
    if (!done) return reply.code(404).send({ statusMessage: 'No active sharing consent for this lead.' })
    await auditLog(fastify, request, 'partner.consent.withdraw', 'lead', p.leadId)
    return reply.send({ ok: true })
  })
}
