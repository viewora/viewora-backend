import { FastifyInstance } from 'fastify'

export default async function (fastify: FastifyInstance) {
  // PUBLIC ROUTE: Submit a lead
  fastify.post('/', async (request, reply) => {
    const body = request.body as any
    const { propertyId, name, email, phone, message, source } = body

    if (!propertyId) {
      return reply.code(400).send({ statusMessage: 'propertyId is required' })
    }

    const { data, error } = await fastify.supabase
      .from('leads')
      .insert({
        property_id: propertyId,
        name,
        email,
        phone,
        message,
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
      await fastify.supabase.rpc('increment_daily_leads', { prop_id: propertyId, event_date: today })
    } catch {
      // Non-fatal — ignore
    }

    return reply.code(201).send(data)
  })

  // AUTH ROUTE: Get all leads for the user's properties
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

  // AUTH ROUTE: Get leads for a specific property
  fastify.get('/property/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const { id } = request.params as any

    // Verify ownership via Supabase select
    const { data: property } = await fastify.supabase
      .from('properties')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single()

    if (!property) {
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
