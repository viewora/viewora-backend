import { FastifyInstance } from 'fastify'

export default async function (fastify: FastifyInstance) {
  // PUBLIC ROUTE: Increment views
  fastify.post('/view', async (request, reply) => {
    const { propertyId, source } = request.body as any
    const today = new Date().toISOString().split('T')[0]

    if (!propertyId) return reply.code(400).send()

    // Increment in summary table
    const { error } = await fastify.supabase.rpc('increment_daily_views', {
      prop_id: propertyId,
      event_date: today,
      view_source: source || 'direct'
    })

    if (error) {
        // Fallback: manual upsert if RPC doesn't exist
        const { data: existing } = await fastify.supabase
            .from('analytics_daily')
            .select('*')
            .eq('property_id', propertyId)
            .eq('date', today)
            .single()

        if (existing) {
            const updates: any = { total_views: existing.total_views + 1 }
            const sourceKey = `${source || 'direct'}_views`
            updates[sourceKey] = (existing[sourceKey] || 0) + 1
            
            await fastify.supabase
                .from('analytics_daily')
                .update(updates)
                .eq('id', existing.id)
        } else {
            await fastify.supabase
                .from('analytics_daily')
                .insert({
                    property_id: propertyId,
                    date: today,
                    total_views: 1,
                    [`${source || 'direct'}_views`]: 1
                })
        }
    }

    return reply.code(204).send()
  })

  // AUTH ROUTE: Get total summary for all properties
  fastify.get('/summary', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    // Fetch daily stats for all user's properties
    const { data, error } = await fastify.supabase
      .from('analytics_daily')
      .select('*, properties!inner(user_id, title)')
      .eq('properties.user_id', userId)
      .order('date', { ascending: false })

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch analytics' })
    }

    return reply.send(data)
  })

  // AUTH ROUTE: Get property stats
  fastify.get('/summary/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const { id } = request.params as any

    const { data, error } = await fastify.supabase
      .from('analytics_daily')
      .select('*, properties!inner(user_id)')
      .eq('property_id', id)
      .eq('properties.user_id', userId)
      .order('date', { ascending: false })
      .limit(30)

    if (error) return reply.code(500).send({ statusMessage: 'Failed to fetch analytics' })
    return reply.send(data)
  })
}
