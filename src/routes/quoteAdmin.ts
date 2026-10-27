// Staff side of the quote engine, called by viewora-admin's server proxy.
// Every request must carry the shared admin secret (proves it came from the
// admin server) and X-Admin-Id (the signed-in staff member, already checked
// there against profiles.is_admin). Each route then checks that staff
// member's quote-engine role from qe_staff; admins without a staff row can
// read but not change anything.

import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { supabaseAdminStore, type QuoteAdminStore, type StaffRole } from '../quote/adminStore.js'
import { modules } from '../quote/modules/index.js'
import { CLIENT_TYPE_LABELS, industryLabel } from '../quote/industries.js'
import type { QuoteStore } from '../quote/store.js'
import { supabaseStore } from '../quote/supabaseStore.js'

const TIMING_LABELS: Record<string, string> = { this_week: 'This week', this_month: 'This month', planning: 'Just planning' }

// Answers as staff read them: the module's own question and option wording
export function answersView(request: Record<string, any>, itemLabel: (key: string) => string = k => k): Array<{ label: string; value: string }> {
  const module = request.moduleKey ? modules[request.moduleKey] : undefined
  const a = request.answers ?? {}
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Industry', value: industryLabel(module?.label, request.flags ?? []) },
    { label: 'Who they are', value: request.clientType ? CLIENT_TYPE_LABELS[request.clientType] ?? request.clientType : 'Not given' },
  ]
  for (const q of module?.questions ?? []) {
    const v = a.details?.[q.id]
    if (v === undefined || v === null || v === '') continue
    const option = q.options?.find(o => o.value === String(v))
    rows.push({ label: q.label, value: option?.label ?? (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)) })
  }
  const addons = Object.entries(a.addons ?? {}) as Array<[string, number]>
  if (addons.length) rows.push({ label: 'Extras', value: addons.map(([k, n]) => (n > 1 ? `${itemLabel(k)} × ${n}` : itemLabel(k))).join(', ') })
  const loc = a.location
  if (loc) {
    const parts = [loc.town, loc.lat !== undefined && loc.lng !== undefined ? `pin ${loc.lat}, ${loc.lng}` : null].filter(Boolean)
    rows.push({ label: 'Where', value: parts.join(' · ') })
  }
  if (a.timing) rows.push({ label: 'When', value: TIMING_LABELS[a.timing] ?? a.timing })
  if (a.note) rows.push({ label: 'Note', value: a.note })
  return rows
}

export type Permission = 'leads:read'

const PERMISSIONS: Record<Permission, StaffRole[]> = {
  'leads:read': ['admin', 'sales', 'viewer'],
}

const STAGES = ['new', 'contacted', 'quoted', 'booked', 'delivered', 'paid', 'lost'] as const

const leadsQuery = z.object({
  stage: z.enum(STAGES).optional(),
  industry: z.string().trim().regex(/^[a-z_]{1,40}$/).optional(),
  source: z.string().trim().min(1).max(40).optional(),
  status: z.enum(['completed', 'abandoned']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const leadParams = z.object({ id: z.string().uuid() })
const uuid = z.string().uuid()

function secretMatches(header: string | undefined): boolean {
  const secret = process.env.ADMIN_SECRET
  if (!secret || !header) return false
  const expected = Buffer.from(`Bearer ${secret}`)
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

declare module 'fastify' {
  interface FastifyRequest { quoteStaff?: { id: string; role: StaffRole } }
}

export default async function quoteAdminRoutes(fastify: FastifyInstance, opts: { adminStore?: QuoteAdminStore; store?: QuoteStore }) {
  const store = opts.adminStore ?? supabaseAdminStore(fastify.supabase)
  const quoteStore = opts.store ?? supabaseStore(fastify.supabase)

  fastify.addHook('preHandler', async (request, reply) => {
    if (!secretMatches(request.headers.authorization)) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', statusMessage: 'Unauthorized' })
    }
    const adminId = uuid.safeParse(request.headers['x-admin-id'])
    if (!adminId.success) {
      return reply.code(401).send({ code: 'NO_STAFF_ID', statusMessage: 'Sign in again: your staff identity was missing.' })
    }
    const role = await store.staffRole(adminId.data)
    request.quoteStaff = { id: adminId.data, role: role ?? 'viewer' }
  })

  const allowed = (request: FastifyRequest, reply: FastifyReply, permission: Permission) => {
    if (request.quoteStaff && PERMISSIONS[permission].includes(request.quoteStaff.role)) return true
    reply.code(403).send({ code: 'FORBIDDEN', statusMessage: 'Your role cannot do this. Ask an admin to change it.' })
    return false
  }

  // GET /admin/quote/summary: counts for the strip above the list, filter choices
  fastify.get('/summary', async (request, reply) => {
    if (!allowed(request, reply, 'leads:read')) return
    return { role: request.quoteStaff!.role, ...await store.summary() }
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
}
