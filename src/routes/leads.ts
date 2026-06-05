import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { sanitizeLeadPhone, sanitizeLeadText } from '../utils/sanitize.js'
import { sendLeadNotification } from '../email/index.js'
import { trackServer } from '../utils/analytics.js'

const leadBodySchema = z.object({
  spaceId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(20).optional(),
  message: z.string().max(1000).optional(),
  source: z.enum(['direct', 'qr', 'embed', 'hotspot']).optional(),
}).superRefine((data, ctx) => {
  if (!data.spaceId && !data.propertyId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'spaceId or propertyId is required',
      path: ['spaceId'],
    })
  }
})

const idParamsSchema = z.object({
  id: z.string().uuid(),
})

const patchLeadBodySchema = z.object({
  status: z.enum(['new', 'contacted', 'qualified', 'closed']),
})

export default async function (fastify: FastifyInstance) {
  // PUBLIC ROUTE: Submit a lead
  fastify.post('/', {
    config: {
      rateLimit: {
        max: 3,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const body = parseWithSchema(reply, leadBodySchema, request.body)
    if (!body) return

    const { spaceId, propertyId, name, email, phone, message, source } = body
    const finalId = spaceId || propertyId
    const cleanName = sanitizeLeadText(name, 100)
    const cleanEmail = email.trim().toLowerCase().slice(0, 254)
    const cleanPhone = sanitizeLeadPhone(phone)
    const cleanMessage = message ? sanitizeLeadText(message, 1000) : null

    // Verify the space exists, is published, and has lead capture enabled.
    // Prevents lead spam into arbitrary UUIDs and respects the owner's settings.
    const { data: space, error: spaceErr } = await fastify.supabase
      .from('properties')
      .select('id, is_published, lead_form_enabled')
      .eq('id', finalId)
      .single()

    if (spaceErr || !space) {
      return reply.code(404).send({ statusMessage: 'Tour not found' })
    }
    if (!space.is_published) {
      return reply.code(403).send({ statusMessage: 'This tour is not published' })
    }
    if (!space.lead_form_enabled) {
      return reply.code(403).send({ statusMessage: 'Lead capture is disabled for this tour' })
    }

    const { data, error } = await fastify.supabase
      .from('leads')
      .insert({
        property_id: finalId,
        name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
        message: cleanMessage,
        source: source || 'direct'
      })
      .select()
      .single()

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to save lead' })
    }

    // Optional: Increment lead count in analytics_daily
    const today = new Date().toISOString().split('T')[0]
    try {
      await fastify.supabase.rpc('increment_daily_leads', { prop_id: finalId, event_date: today })
    } catch {
      // Non-fatal — ignore
    }

    // Fire-and-forget: notify space owner by email
    void (async () => {
      try {
        const { data: prop } = await fastify.supabase
          .from('properties')
          .select('title, slug, user_id')
          .eq('id', finalId)
          .single()

        if (!prop?.user_id || !prop?.slug) return

        trackServer(prop.user_id, 'lead_received', { space_id: finalId, source: source || 'direct' })

        const { data: ownerData, error: ownerErr } = await fastify.supabase.auth.admin.getUserById(prop.user_id)
        if (ownerErr || !ownerData?.user?.email) return
        const owner = ownerData.user

        await sendLeadNotification({
          ownerEmail: owner.email!,
          spaceName: prop.title,
          spaceSlug: prop.slug,
          lead: { name: cleanName, email: cleanEmail, phone: cleanPhone, message: cleanMessage },
        })
      } catch (err) {
        fastify.log.error(err, 'Lead notification email failed')
      }
    })()

    return reply.code(201).send(data)
  })

  // AUTH ROUTE: Get all leads for the user's spaces
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const query = request.query as { page?: string; limit?: string }
    const limit = Math.min(Number(query.limit) || 100, 500)
    const page = Math.max(Number(query.page) || 1, 1)
    const from = (page - 1) * limit
    const to = from + limit - 1

    const { data: leads, error, count } = await fastify.supabase
      .from('leads')
      .select('*, properties!inner(id, title, slug, user_id)', { count: 'exact' })
      .eq('properties.user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch leads' })
    }

    // Map DB shape → frontend shape (property_id→project_id, properties→projects)
    const transformed = (leads ?? []).map((l: any) => ({
      ...l,
      project_id: l.property_id,
      projects: l.properties
        ? { id: l.properties.id, name: l.properties.title, slug: l.properties.slug ?? null }
        : null,
    }))

    return reply.send({ data: transformed, total: count ?? 0, page, limit })
  })

  // AUTH ROUTE: Count leads created within the last N days
  fastify.get('/count', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const query = request.query as { days?: string }
    const days = Math.min(Math.max(Number(query.days) || 7, 1), 365)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    const { count, error } = await fastify.supabase
      .from('leads')
      .select('*, properties!inner(user_id)', { count: 'exact', head: true })
      .eq('properties.user_id', userId)
      .gte('created_at', since)

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to count leads' })
    }

    return reply.send({ count: count ?? 0, days })
  })

  // AUTH ROUTE: Get leads for a specific space
  fastify.get('/space/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

    // Verify ownership via Supabase select
    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (!space) {
      return reply.code(403).send({ statusMessage: 'Unauthorized' })
    }

    const { data: leads, error } = await fastify.supabase
      .from('leads')
      .select('*')
      .eq('property_id', id)
      .order('created_at', { ascending: false })

    if (error) return reply.code(500).send({ statusMessage: 'Failed to fetch leads' })
    return reply.send(leads)
  })

  // AUTH ROUTE: Update lead status
  fastify.patch('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const body = parseWithSchema(reply, patchLeadBodySchema, request.body)
    if (!body) return

    // Verify ownership: lead must belong to a space owned by this user
    const { data: lead } = await fastify.supabase
      .from('leads')
      .select('id, property_id')
      .eq('id', params.id)
      .single()

    if (!lead) return reply.code(404).send({ statusMessage: 'Lead not found' })

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', lead.property_id)
      .eq('user_id', userId)
      .single()

    if (!space) return reply.code(403).send({ statusMessage: 'Unauthorized' })

    const { data: updated, error } = await fastify.supabase
      .from('leads')
      .update({ status: body.status, updated_at: new Date().toISOString() })
      .eq('id', params.id)
      .select('id, status, updated_at')
      .single()

    if (error) return reply.code(500).send({ statusMessage: 'Failed to update lead' })
    return reply.send(updated)
  })

  // AUTH ROUTE: Delete a lead
  fastify.delete('/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return

    // Verify ownership
    const { data: lead } = await fastify.supabase
      .from('leads')
      .select('id, property_id')
      .eq('id', params.id)
      .single()

    if (!lead) return reply.code(404).send({ statusMessage: 'Lead not found' })

    const { data: space } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', lead.property_id)
      .eq('user_id', userId)
      .single()

    if (!space) return reply.code(403).send({ statusMessage: 'Unauthorized' })

    const { error } = await fastify.supabase
      .from('leads')
      .delete()
      .eq('id', params.id)

    if (error) return reply.code(500).send({ statusMessage: 'Failed to delete lead' })
    return reply.code(204).send()
  })
}
