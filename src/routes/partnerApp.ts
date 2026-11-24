import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { claimService, type ClaimService } from '../partners/claims.js'
import { leadConsent, supabaseConsentDeps } from '../partners/leadConsent.js'
import { supabaseListingStore, type ListingStore } from '../partners/listingStore.js'
import { supabaseStore, type PartnerStore } from '../partners/store.js'

// The listing platform as Viewora app users see it, under /partner:
//   GET  /partner/claims                 requests from partners to manage my tours
//   POST /partner/claims/:id/approve     link the tour to the partner listing
//   POST /partner/claims/:id/decline
//   GET  /partner/lead-consent/:spaceId  (public) the sharing wording for a tour's lead form
// Registered only when PARTNER_LISTINGS_ENABLED=1.

export type PartnerAppOptions = { listings?: ListingStore; partners?: PartnerStore; claims?: ClaimService; consent?: ReturnType<typeof leadConsent> }

const idParams = z.object({ id: z.string().uuid() })
const spaceParams = z.object({ spaceId: z.string().uuid() })
const localeQuery = z.object({ locale: z.string().regex(/^[a-z]{2}$/).default('en') })

export default async function partnerApp(fastify: FastifyInstance, opts: PartnerAppOptions = {}) {
  const listings = opts.listings ?? supabaseListingStore(fastify)
  const partners = opts.partners ?? supabaseStore(fastify)
  const claims = opts.claims ?? claimService({ partners, listings })
  const consent = opts.consent ?? leadConsent(supabaseConsentDeps(fastify, listings))
  const userId = (request: any) => String(request.user?.sub ?? '')

  fastify.get('/claims', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    return reply.send({ claims: await claims.forUser(userId(request)) })
  })

  for (const action of ['approve', 'decline'] as const) {
    fastify.post(`/claims/:id/${action}`, {
      preHandler: [fastify.authenticate],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const p = parseWithSchema(reply, idParams, request.params)
      if (!p) return
      const r = await claims.decide(userId(request), p.id, action === 'approve')
      if (r.status >= 400) return reply.code(r.status).send({ statusMessage: r.body.error.message, code: r.body.error.code })
      return reply.send(r.body)
    })
  }

  fastify.get('/lead-consent/:spaceId', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const p = parseWithSchema(reply, spaceParams, request.params)
    if (!p) return
    const q = localeQuery.safeParse(request.query ?? {})
    const w = await consent.wordingFor(p.spaceId, q.success ? q.data.locale : 'en')
    reply.header('cache-control', 'public, max-age=300')
    return reply.send({ consent: w })
  })
}
