import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const tourParamsSchema = z.object({
  slug: z.string().min(3).max(120).regex(/^[a-z0-9-]+$/, 'Invalid slug'),
})

export default async function publicRoutes(fastify: FastifyInstance) {

  // ── PUBLIC TOUR VIEWER ────────────────────────────────────
  // No auth required. Calls the get_tour_data() RPC which checks
  // is_published=true AND visibility='public' before returning anything.
  fastify.get('/p/:slug', async (req, reply) => {
    const params = parseWithSchema(reply, tourParamsSchema, (req as any).params)
    if (!params) return

    const { data, error } = await fastify.supabase
      .rpc('get_tour_data', { p_slug: params.slug })

    if (error) throw error
    if (!data) return reply.code(404).send({ statusMessage: 'Tour not found' })

    // Record a property_view analytics event (fire-and-forget, never blocks the response)
    const spaceId = (data as any)?.space?.id
    if (spaceId) {
      void Promise.resolve(
        fastify.supabase.from('analytics_events').insert({
          property_id: spaceId,
          event_type: 'property_view',
          source: 'direct',
          user_agent: req.headers['user-agent'] ?? null,
          referrer: req.headers['referer'] ?? null,
        })
      ).catch((err: any) => {
        fastify.log.warn({ err: err?.message }, 'Failed to record tour view event')
      })
    }

    return reply.send({ tour: data })
  })
}
