// Ordering a capture from a Viewora account (under /quote/account). Every
// route needs a signed-in user (the app's Supabase session, checked by the
// existing authenticate hook). The form itself is the public one; these only
// tie a request to the account and, for someone whose number is already on
// file with consent, fill the contact step so they go straight to details.
//
//   GET  /account/me                        what the order form can prefill, and past orders
//   POST /account/requests/:token/claim     this request is mine (straight after starting it)
//   POST /account/requests/:token/contact   skip the contact step with the number on file
//   GET  /account/deliveries/:token         a tour the studio is handing over (quoteDeliveries.ts)
//   POST /account/deliveries/:token/accept  move it into this account

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import type { QuoteStore, RequestRecord } from '../quote/store.js'
import type { AccountStore } from '../quote/accountStore.js'
import { normalisePhone } from '../quote/engine/phone.js'
import type { DeliveryStore } from '../quote/deliveryStore.js'
import type { JobStore } from '../quote/jobStore.js'
import { hashToken } from '../quote/messaging.js'

const tokenParams = z.object({ token: z.string().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/) })
const deliveryParams = z.object({ token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/) })

export interface AccountRouteOptions {
  accounts: AccountStore
  store: QuoteStore
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  loadRequest: (token: string, reply: FastifyReply) => Promise<RequestRecord | null>
  saveContact: (req: RequestRecord, reached: number, c: { firstName: string; whatsappE164: string; email: string | null; consent: boolean }) => Promise<RequestRecord>
  publicView: (req: RequestRecord) => unknown
  deliveries: DeliveryStore
  jobs: JobStore
  now: () => Date
}

// "Peter Musis" → "Peter"
const firstNameOf = (full: string | null) => full?.trim().split(/\s+/)[0]?.slice(0, 60) || null

export default async function quoteAccountRoutes(fastify: FastifyInstance, opts: AccountRouteOptions) {
  const { accounts, store, loadRequest, saveContact, publicView, deliveries, jobs, now } = opts
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: (r: any) => r.user?.sub ?? r.ip } })
  fastify.addHook('preHandler', opts.authenticate)

  const userOf = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const user = request.user as { sub?: string; is_anonymous?: boolean } | undefined
    if (!user?.sub) { reply.code(401).send({ code: 'SIGN_IN', statusMessage: 'Sign in to order from your account.' }); return null }
    // A guest session has no profile to order with; the public form is for them
    if (user.is_anonymous) { reply.code(403).send({ code: 'SIGN_IN', statusMessage: 'Create an account or sign in to order from here.' }); return null }
    return user.sub
  }

  // Their own details only, so this is the one place a phone number is sent back
  fastify.get('/me', { config: limit(30) }, async (request, reply) => {
    const userId = userOf(request, reply)
    if (!userId) return
    const [profile, onFile, orders] = await Promise.all([accounts.profile(userId), accounts.consentedLead(userId), accounts.orders(userId, 10)])
    const phone = profile.phone ? normalisePhone(profile.phone) : null
    reply.header('Cache-Control', 'private, no-store')
    return {
      // On file: the contact step is skipped and this is what we will use
      onFile: onFile ? { firstName: onFile.firstName, whatsapp: onFile.whatsappE164, email: onFile.email } : null,
      // Otherwise the contact step opens filled in from the profile; consent is still theirs to tick
      prefill: {
        firstName: firstNameOf(profile.fullName),
        whatsapp: phone?.ok ? phone.e164 : null,
        email: profile.email,
      },
      orders,
    }
  })

  fastify.post('/requests/:token/claim', { config: limit(20) }, async (request, reply) => {
    const userId = userOf(request, reply)
    if (!userId) return
    const params = parseWithSchema(reply, tokenParams, request.params)
    if (!params) return
    const req = await loadRequest(params.token, reply)
    if (!req) return
    // Only a fresh request: one that already has a lead was someone's public form
    if (req.leadId) return reply.code(409).send({ code: 'ALREADY_STARTED', statusMessage: 'This quote was started without your account. Start a new one from Capture.' })
    if (!(await accounts.markRequest(req.id, userId))) return reply.code(409).send({ code: 'ALREADY_STARTED', statusMessage: 'This quote belongs to another account.' })
    const next = req.entry.source ? req : await store.updateRequest(req.id, { entry: { ...req.entry, source: 'app' } })
    return { request: publicView(next) }
  })

  fastify.post('/requests/:token/contact', { config: limit(20) }, async (request, reply) => {
    const userId = userOf(request, reply)
    if (!userId) return
    const params = parseWithSchema(reply, tokenParams, request.params)
    if (!params) return
    const req = await loadRequest(params.token, reply)
    if (!req) return
    if ((await accounts.requestUser(req.id)) !== userId) return reply.code(403).send({ code: 'NOT_YOURS', statusMessage: 'This quote was not started from your account.' })
    const onFile = await accounts.consentedLead(userId)
    if (!onFile) return reply.code(409).send({ code: 'CONTACT_NEEDED', statusMessage: 'Add your WhatsApp number once, then we keep it for next time.' })
    // Consent is already on that lead; nothing new is agreed to here
    const next = await saveContact(req, Math.max(req.stepReached, 2), {
      firstName: onFile.firstName ?? 'there', whatsappE164: onFile.whatsappE164, email: onFile.email, consent: false,
    })
    return { request: publicView(next) }
  })

  // ── Tour delivery ─────────────────────────────────────────────────────
  // The link is the credential, so every way it can fail looks the same
  const gone = (reply: FastifyReply) => reply.code(404).send({ code: 'LINK_GONE', statusMessage: 'This link has expired or was already used. Ask us on WhatsApp for a new one.' })

  // An open link, and the job it belongs to, for this signed-in user
  async function openDelivery(request: FastifyRequest, reply: FastifyReply) {
    const userId = userOf(request, reply)
    if (!userId) return null
    const params = parseWithSchema(reply, deliveryParams, request.params)
    if (!params) return null
    const delivery = await deliveries.byToken(hashToken(params.token))
    if (!delivery) { gone(reply); return null }
    // Opened again by the account that accepted it: show where it went
    if (delivery.status === 'accepted' && delivery.toUserId === userId) return { userId, delivery }
    if (delivery.status !== 'pending' || delivery.expiresAt < now().toISOString()) { gone(reply); return null }
    const job = await jobs.job(delivery.jobId)
    if (!job || job.status === 'cancelled') { gone(reply); return null }
    // A lead already tied to an account only takes delivery into that account
    const leadUser = await accounts.leadUser(job.leadId)
    if (leadUser && leadUser !== userId) {
      reply.code(403).send({ code: 'OTHER_ACCOUNT', statusMessage: 'This tour is for a different Viewora account. Sign in with the account you ordered from.' })
      return null
    }
    return { userId, delivery, leadId: job.leadId }
  }

  const deliveryView = async (d: { propertyId: string; status: string; expiresAt: string }) => {
    const tour = await deliveries.tour(d.propertyId)
    return { status: d.status, expiresAt: d.expiresAt, tour: tour ? { id: tour.id, title: tour.title, coverUrl: tour.coverUrl } : null }
  }

  fastify.get('/deliveries/:token', { config: limit(30) }, async (request, reply) => {
    const open = await openDelivery(request, reply)
    if (!open) return
    reply.header('Cache-Control', 'private, no-store')
    return deliveryView(open.delivery)
  })

  fastify.post('/deliveries/:token/accept', { config: limit(10) }, async (request, reply) => {
    const open = await openDelivery(request, reply)
    if (!open) return
    if (open.delivery.status === 'accepted') return deliveryView(open.delivery)
    const result = await deliveries.accept(open.delivery.id, open.userId)
    if (result === 'owner_changed') {
      request.log.error({ deliveryId: open.delivery.id }, 'quote delivery: tour left the studio account before it was accepted')
      return reply.code(409).send({ code: 'NOT_READY', statusMessage: 'We could not move this tour right now. We have been told and will send a new link.' })
    }
    if (result !== 'ok') return gone(reply)
    // The lead is theirs from now on, if it was not already
    if (open.leadId) await accounts.linkLead(open.leadId, open.userId)
    request.log.info({ deliveryId: open.delivery.id }, 'quote delivery: accepted')
    return deliveryView((await deliveries.get(open.delivery.id))!)
  })
}
