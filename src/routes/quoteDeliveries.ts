// Delivering the finished tour into the client's account (under /admin/quote).
// Staff build the tour in the studio account (QUOTE_STUDIO_USER_ID), pick it
// on the job page and send the client a link. The tour only moves when the
// client opens the link signed in and accepts it (quoteAccount.ts).
//
//   GET  /studio-tours?q=             tours in the studio account, to pick from
//   GET  /jobs/:id/deliveries         links sent for this job
//   POST /jobs/:id/deliveries         a new link for a studio tour (revokes an open one for it)
//   POST /deliveries/:id/revoke       the link stops working
//   POST /deliveries/:id/undo         move an accepted tour back to the studio (admin)

import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import type { QuoteStore } from '../quote/store.js'
import type { DeskStore } from '../quote/deskStore.js'
import type { JobStore } from '../quote/jobStore.js'
import type { DeliveryStore } from '../quote/deliveryStore.js'
import { allowed } from '../quote/staffAuth.js'
import { inQuietHours, nairobiDate } from '../quote/desk.js'
import { hashToken } from '../quote/messaging.js'
import { render } from '../quote/alerts.js'

export const TEMPLATE_TOUR_DELIVERY = 'tour_delivery'
export const DELIVERY_DAYS = 30

const idParams = z.object({ id: z.string().uuid() })
const createBody = z.object({ propertyId: z.string().uuid() }).strict()
const undoBody = z.object({ reason: z.string().trim().min(3).max(300) }).strict()
const toursQuery = z.object({ q: z.string().trim().max(80).optional() })

export interface DeliveryRouteOptions {
  deliveries: DeliveryStore
  store: QuoteStore
  desk: DeskStore
  jobs: JobStore
  studioUserId: string | null
  publicUrl: string
  now: () => Date
}

export default async function quoteDeliveryRoutes(fastify: FastifyInstance, opts: DeliveryRouteOptions) {
  const { deliveries, store, desk, jobs, studioUserId, publicUrl, now } = opts
  const notSetUp = { code: 'STUDIO_NOT_SET', statusMessage: 'Set QUOTE_STUDIO_USER_ID to the account staff build tours in, then try again.' }

  fastify.get('/studio-tours', async (request, reply) => {
    if (!allowed(request, reply, 'tours:deliver')) return
    const query = parseWithSchema(reply, toursQuery, request.query)
    if (!query) return
    if (!studioUserId) return reply.code(409).send(notSetUp)
    return { tours: await deliveries.studioTours(studioUserId, query.q || undefined, 30) }
  })

  fastify.get('/jobs/:id/deliveries', async (request, reply) => {
    if (!allowed(request, reply, 'jobs:read')) return
    const params = parseWithSchema(reply, idParams, request.params)
    if (!params) return
    if (!(await jobs.job(params.id))) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'That job no longer exists.' })
    return { studioReady: !!studioUserId, deliveries: await deliveries.forJob(params.id) }
  })

  fastify.post('/jobs/:id/deliveries', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!allowed(request, reply, 'tours:deliver')) return
    const params = parseWithSchema(reply, idParams, request.params)
    const body = params && parseWithSchema(reply, createBody, request.body)
    if (!params || !body) return
    if (!studioUserId) return reply.code(409).send(notSetUp)
    const job = await jobs.job(params.id)
    if (!job) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'That job no longer exists.' })
    if (job.status === 'cancelled') return reply.code(409).send({ code: 'JOB_CANCELLED', statusMessage: 'This job was cancelled.' })
    const tour = await deliveries.tour(body.propertyId)
    if (!tour || tour.userId !== studioUserId) {
      return reply.code(409).send({ code: 'NOT_STUDIO_TOUR', statusMessage: 'Pick a tour that is in the studio account.' })
    }
    const lead = await desk.lead(job.leadId)
    if (!lead) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'The lead for this job no longer exists.' })

    const token = crypto.randomBytes(32).toString('base64url')
    const expires = new Date(now().getTime() + DELIVERY_DAYS * 86_400_000)
    const staffId = request.quoteStaff!.id
    const delivery = await deliveries.create({ jobId: job.id, propertyId: tour.id, fromUserId: studioUserId, expiresAt: expires.toISOString(), createdBy: staffId }, hashToken(token))
    const url = `${publicUrl}/deliver/${token}`

    // Click-to-chat, as for the balance link: staff press send themselves.
    // Never to an opted-out client, or in quiet hours; the link still works.
    let waUrl: string | null = null
    let waBlocked: string | null = null
    if (lead.optedOutAt) waBlocked = 'This client asked not to be contacted. Give them the link another way.'
    else if (!lead.whatsappE164) waBlocked = 'There is no WhatsApp number on this lead.'
    else if (inQuietHours(now())) waBlocked = 'We only message clients between 07:00 and 21:00 Nairobi time. Copy the link and send it after 07:00.'
    else {
      const template = await store.messageTemplate(TEMPLATE_TOUR_DELIVERY, 'whatsapp')
      if (!template) waBlocked = `The "${TEMPLATE_TOUR_DELIVERY}" WhatsApp wording is missing. Run migration 010.`
      else {
        const text = render(template.body, { name: lead.firstName ?? '', delivery_link: url, expires_on: nairobiDate(expires) })
        waUrl = `https://wa.me/${lead.whatsappE164.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`
        await store.recordMessage({
          leadId: lead.id, quoteId: job.quoteId, channel: 'whatsapp', templateKey: TEMPLATE_TOUR_DELIVERY, templateVersion: template.version,
          renderedBody: text, status: 'sent', skipReason: 'click_to_chat', sentAt: now().toISOString(),
        })
      }
    }
    reply.header('Cache-Control', 'private, no-store')
    // The link is shown once, here; only its hash is stored
    return reply.code(201).send({ delivery, url, waUrl, waBlocked })
  })

  fastify.post('/deliveries/:id/revoke', async (request, reply) => {
    if (!allowed(request, reply, 'tours:deliver')) return
    const params = parseWithSchema(reply, idParams, request.params)
    if (!params) return
    if (!(await deliveries.revoke(params.id, request.quoteStaff!.id))) {
      return reply.code(409).send({ code: 'NOT_PENDING', statusMessage: 'This link was already used or stopped.' })
    }
    return { delivery: await deliveries.get(params.id) }
  })

  fastify.post('/deliveries/:id/undo', async (request, reply) => {
    if (!allowed(request, reply, 'tours:undo')) return
    const params = parseWithSchema(reply, idParams, request.params)
    const body = params && parseWithSchema(reply, undoBody, request.body)
    if (!params || !body) return
    const result = await deliveries.undo(params.id, request.quoteStaff!.id, body.reason)
    if (result === 'not_accepted') return reply.code(409).send({ code: 'NOT_ACCEPTED', statusMessage: 'Only a tour the client accepted can be moved back.' })
    if (result === 'owner_changed') return reply.code(409).send({ code: 'OWNER_CHANGED', statusMessage: 'The client no longer owns this tour, so it was not moved.' })
    return { delivery: await deliveries.get(params.id) }
  })
}
