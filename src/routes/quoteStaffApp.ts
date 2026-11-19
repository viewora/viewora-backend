// Partners and commission for staff signed in to the main app (under /staff/quote).
//
// /admin/quote is reached through viewora-admin's server, which holds
// ADMIN_SECRET. The main app must never hold that secret, so this group takes
// the user's own Supabase session instead, then requires profiles.is_admin.
// The quote-engine role comes from qe_staff exactly as on /admin/quote:
// admins without a staff row can read but not change anything.
//
//   GET  /me                        the caller's staff role, or role null for anyone else (the sidebar asks)
//   ...  /links, /partners, /commission, /commission.csv, /commission/payouts
//        the same routes as /admin/quote (see quoteLinks.ts)

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { QuoteStore } from '../quote/store.js'
import { supabaseStore } from '../quote/supabaseStore.js'
import { supabaseDeskStore, type DeskStore } from '../quote/deskStore.js'
import { linkStoreFor, type LinkStore } from '../quote/linkStore.js'
import quoteLinkRoutes from './quoteLinks.js'

export type IsAdminFn = (userId: string) => Promise<boolean>
type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>

export default async function quoteStaffAppRoutes(fastify: FastifyInstance, opts: {
  store?: QuoteStore; desk?: DeskStore; links?: LinkStore
  now?: () => Date; publicUrl?: string
  // Injected in tests; default to the auth plugin and profiles.is_admin
  authenticate?: Authenticate; isAdmin?: IsAdminFn
}) {
  const store = opts.store ?? supabaseStore(fastify.supabase)
  const desk = opts.desk ?? supabaseDeskStore(fastify.supabase)
  const links = opts.links ?? linkStoreFor(store, fastify.supabase)
  const authenticate = opts.authenticate ?? fastify.authenticate
  const isAdmin: IsAdminFn = opts.isAdmin ?? (async (userId) => {
    const { data, error } = await fastify.supabase.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
    if (error) throw error
    return data?.is_admin === true
  })

  fastify.addHook('preHandler', async (request, reply) => {
    await authenticate(request, reply)
    if (reply.sent) return
    const userId: string | undefined = request.user?.id
    if (!userId || request.user?.is_anonymous || !(await isAdmin(userId))) {
      // The sidebar asks /me for every signed-in user: a plain "no" there, not an error
      if ((request.routeOptions.config as { staffProbe?: boolean } | undefined)?.staffProbe) return reply.send({ role: null, displayName: null })
      return reply.code(403).send({ code: 'NOT_STAFF', statusMessage: 'Only Viewora staff can open this.' })
    }
    const member = await desk.staff(userId)
    request.quoteStaff = member
      ? { id: member.userId, role: member.role, displayName: member.displayName, discountLimitBp: member.discountLimitBp }
      : { id: userId, role: 'viewer', displayName: null, discountLimitBp: 0 }
  })

  fastify.get('/me', { config: { staffProbe: true } }, async (request) => {
    const s = request.quoteStaff!
    return { role: s.role, displayName: s.displayName }
  })

  await fastify.register(quoteLinkRoutes, {
    links, store, now: opts.now ?? (() => new Date()),
    publicUrl: (opts.publicUrl ?? process.env.QUOTE_PUBLIC_URL ?? 'https://app.viewora.software').replace(/\/$/, ''),
  })
}
