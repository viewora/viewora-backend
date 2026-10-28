// Ordering a capture from a Viewora account (under /quote/account). Every
// route needs a signed-in user (the app's Supabase session, checked by the
// existing authenticate hook). The form itself is the public one; these only
// tie a request to the account and, for someone whose number is already on
// file with consent, fill the contact step so they go straight to details.
//
//   GET  /account/me                        what the order form can prefill, and past orders
//   POST /account/requests/:token/claim     this request is mine (straight after starting it)
//   POST /account/requests/:token/contact   skip the contact step with the number on file

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import type { QuoteStore, RequestRecord } from '../quote/store.js'
import type { AccountStore } from '../quote/accountStore.js'
import { normalisePhone } from '../quote/engine/phone.js'

const tokenParams = z.object({ token: z.string().min(20).max(100).regex(/^[A-Za-z0-9_-]+$/) })

export interface AccountRouteOptions {
  accounts: AccountStore
  store: QuoteStore
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  loadRequest: (token: string, reply: FastifyReply) => Promise<RequestRecord | null>
  saveContact: (req: RequestRecord, reached: number, c: { firstName: string; whatsappE164: string; email: string | null; consent: boolean }) => Promise<RequestRecord>
  publicView: (req: RequestRecord) => unknown
}

// "Peter Musis" → "Peter"
const firstNameOf = (full: string | null) => full?.trim().split(/\s+/)[0]?.slice(0, 60) || null

export default async function quoteAccountRoutes(fastify: FastifyInstance, opts: AccountRouteOptions) {
  const { accounts, store, loadRequest, saveContact, publicView } = opts
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
}
