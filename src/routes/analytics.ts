import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const sourceSchema = z.enum(['direct', 'qr', 'embed'])

const viewBodySchema = z.object({
  spaceId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  source: sourceSchema.optional(),
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
  type ViewSource = 'direct' | 'qr' | 'embed'
  const VALID_SOURCES: ViewSource[] = ['direct', 'qr', 'embed']
  const SOURCE_COLUMN: Record<ViewSource, 'direct_views' | 'qr_views' | 'embed_views'> = {
    direct: 'direct_views',
    qr: 'qr_views',
    embed: 'embed_views',
  }

  // PUBLIC ROUTE: Increment views
  fastify.post('/view', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.ip,
      },
    },
  }, async (request, reply) => {
    const body = parseWithSchema(reply, viewBodySchema, request.body)
    if (!body) return

    const spaceId = body.spaceId || body.propertyId || null
    const rawSource = body.source || 'direct'
    const source: ViewSource = VALID_SOURCES.includes(rawSource as ViewSource)
      ? (rawSource as ViewSource)
      : 'direct'
    const today = new Date().toISOString().split('T')[0]

    // Increment via RPC
    const { error } = await fastify.supabase.rpc('increment_daily_views', {
      prop_id: spaceId,
      event_date: today,
      view_source: source,
    })

    if (error) {
      // Fallback: manual upsert if RPC not yet deployed
      const sourceCol = SOURCE_COLUMN[source]
      const { data: existing } = await fastify.supabase
        .from('analytics_daily')
        .select('id, total_views, direct_views, qr_views, embed_views')
        .eq('property_id', spaceId)
        .eq('date', today)
        .single()

      if (existing) {
        await fastify.supabase
          .from('analytics_daily')
          .update({
            total_views: existing.total_views + 1,
            [sourceCol]: (existing[sourceCol] ?? 0) + 1,
          })
          .eq('id', existing.id)
      } else {
        await fastify.supabase
          .from('analytics_daily')
          .insert({
            property_id: spaceId,
            date: today,
            total_views: 1,
            [sourceCol]: 1,
          })
      }
    }

    return reply.code(204).send()
  })

  // AUTH ROUTE: Get total summary for all spaces
  fastify.get('/summary', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub

    // Fetch daily stats for all user's spaces
    const { data, error } = await fastify.supabase
      .from('analytics_daily')
      .select('*, properties!inner(user_id, title)')
      .eq('properties.user_id', userId)
      .order('date', { ascending: false })

    if (error) {
      fastify.log.error(error)
      return reply.code(500).send({ statusMessage: 'Failed to fetch analytics' })
    }

    // Map property_id to space_id for frontend consistency
    const mappedData = (data || []).map(d => ({
      ...d,
      space_id: d.property_id,
      spaces: d.properties
    }))

    return reply.send(mappedData)
  })

  // AUTH ROUTE: Get space stats
  fastify.get('/summary/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = request.user as any
    const userId = user.sub
    const params = parseWithSchema(reply, idParamsSchema, request.params)
    if (!params) return
    const { id } = params

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
