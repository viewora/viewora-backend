import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'
import { sanitizeLeadPhone, sanitizeLeadText } from '../utils/sanitize.js'

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

    return reply.code(201).send(data)
  })

  // AUTH ROUTE: Get all leads for the user's spaces
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    const { data: leads, error } = await fastify.supabase
      .from('leads')
      .select('*, properties!inner(title, user_id)')
      .eq('properties.user_id', userId)
      .order('created_at', { ascending: false })

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch leads' })
    }

    return reply.send(leads)
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
}
