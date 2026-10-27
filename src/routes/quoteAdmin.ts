// Staff side of the quote engine, called by viewora-admin's server proxy.
// The staff check (admin secret, X-Admin-Id, qe_staff role) runs before
// every route here and in the desk and rate table routes registered below.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { supabaseAdminStore, type QuoteAdminStore } from '../quote/adminStore.js'
import type { QuoteStore } from '../quote/store.js'
import { supabaseStore } from '../quote/supabaseStore.js'
import { supabaseDeskStore, type DeskStore } from '../quote/deskStore.js'
import { allowed, staffHook } from '../quote/staffAuth.js'
import quoteDeskRoutes, { type DeskRouteOptions } from './quoteDesk.js'
import quoteRatesRoutes from './quoteRates.js'

export { answersView } from '../quote/answersView.js'
import { answersView } from '../quote/answersView.js'

const STAGES = ['new', 'contacted', 'quoted', 'booked', 'delivered', 'paid', 'lost'] as const

const leadsQuery = z.object({
  stage: z.enum(STAGES).optional(),
  industry: z.string().trim().regex(/^[a-z_]{1,40}$/).optional(),
  source: z.string().trim().min(1).max(40).optional(),
  status: z.enum(['completed', 'abandoned']).optional(),
  q: z.string().trim().max(100).optional(),
  owner: z.union([z.string().uuid(), z.literal('none')]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const leadParams = z.object({ id: z.string().uuid() })

export default async function quoteAdminRoutes(fastify: FastifyInstance, opts: Omit<DeskRouteOptions, 'adminStore' | 'store' | 'desk'> & {
  adminStore?: QuoteAdminStore; store?: QuoteStore; desk?: DeskStore
}) {
  const store = opts.adminStore ?? supabaseAdminStore(fastify.supabase)
  const quoteStore = opts.store ?? supabaseStore(fastify.supabase)
  const desk = opts.desk ?? supabaseDeskStore(fastify.supabase)

  fastify.addHook('preHandler', staffHook(desk))

  // GET /admin/quote/summary: counts for the strip above the list, filter choices
  fastify.get('/summary', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const me = request.quoteStaff!
    return { role: me.role, staff: { id: me.id, name: me.displayName, discountLimitBp: me.discountLimitBp }, ...await store.summary() }
  })

  // GET /admin/quote/leads: one row per lead, newest activity first
  fastify.get('/leads', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const query = parseWithSchema(reply, leadsQuery, request.query)
    if (!query) return
    const { page, limit, ...filter } = query
    const result = await store.leads({ ...filter, q: filter.q || undefined, limit, offset: (page - 1) * limit })
    return { ...result, page, limit }
  })

  // GET /admin/quote/leads/:id: everything about one lead
  fastify.get('/leads/:id', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    const params = parseWithSchema(reply, leadParams, request.params)
    if (!params) return
    const lead = await store.lead(params.id)
    if (!lead) return reply.code(404).send({ code: 'NOT_FOUND', statusMessage: 'No lead with that id. It may have been deleted.' })
    // Reading personal data is logged with who did it
    fastify.log.info({ staffId: request.quoteStaff!.id, leadId: params.id }, 'quote admin: lead viewed')
    const requests = ((lead as any).requests ?? []) as Array<Record<string, any>>
    const table = await quoteStore.publishedRateTable().catch(() => null)
    const itemLabel = (key: string) => table?.items[key]?.label ?? key
    return { ...lead, requests: requests.map(r => ({ ...r, answersView: answersView(r, itemLabel) })) }
  })

  // Child routes share the staff check above (not the prefix: Fastify already applied it)
  const { prefix: _prefix, ...deskOpts } = opts as typeof opts & { prefix?: string }
  await fastify.register(quoteDeskRoutes, { ...deskOpts, adminStore: store, store: quoteStore, desk })
  await fastify.register(quoteRatesRoutes, { desk })
}
