import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseWithSchema } from '../utils/validation.js'

const tourParamsSchema = z.object({
  slug: z.string().min(3).max(120).regex(/^[a-z0-9-]+$/, 'Invalid slug'),
})

const idParamsSchema = z.object({
  id: z.string().uuid(),
})

export default async function publicRoutes(fastify: FastifyInstance) {

  // ── AUTHENTICATED TOUR PREVIEW ─────────────────────────────
  // Requires auth. Allows owners to preview their tour even if it's not published.
  fastify.get('/p/preview/:id', { preHandler: fastify.authenticate }, async (req, reply) => {
    const params = parseWithSchema(reply, idParamsSchema, (req as any).params)
    if (!params) return
    const user = req.user as any
    const userId = user.sub

    // Verify ownership and get slug
    const { data: space, error: spaceError } = await fastify.supabase
      .from('properties')
      .select('slug')
      .eq('id', params.id)
      .eq('user_id', userId)
      .single()

    if (spaceError || !space) {
      return reply.code(404).send({ statusMessage: 'Tour not found or access denied' })
    }

    // Direct query to fetch tour data bypassing the is_published check
    const { data: spaceData, error: spaceDataError } = await fastify.supabase
      .from('properties')
      .select(`
        *,
        scenes:property_media (
          id,
          name,
          order_index,
          raw_image_url,
          tile_manifest_url,
          thumbnail_url,
          status,
          initial_yaw,
          initial_pitch,
          hotspots (
            *
          )
        )
      `)
      .eq('id', params.id)
      .eq('property_media.media_type', 'panorama')
      .single()

    if (spaceDataError || !spaceData) {
      return reply.code(404).send({ statusMessage: 'Tour data unavailable' })
    }

    // Map to match the get_tour_data RPC output shape
    const formattedData = {
      space: spaceData,
      scenes: (spaceData as any).scenes.sort((a: any, b: any) => (a.order_index || 0) - (b.order_index || 0))
    }

    reply.header('X-Cache', 'BYPASS')
    return reply.send({ tour: formattedData })
  })

  // ── PUBLIC TOUR VIEWER ────────────────────────────────────
  // No auth required. Calls the get_tour_data() RPC which checks
  // is_published=true AND visibility='public' before returning anything.
  fastify.get('/p/:slug', async (req, reply) => {
    const params = parseWithSchema(reply, tourParamsSchema, (req as any).params)
    if (!params) return

    const cacheKey = `tour:${params.slug}`

    // Serve from Redis cache when available — skips the Supabase RPC entirely
    if (fastify.redis) {
      const cached = await fastify.redis.get(cacheKey).catch(() => null)
      if (cached) {
        const data = JSON.parse(cached)
        const spaceId = data?.space?.id
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
        reply.header('X-Cache', 'HIT')
        return reply.send({ tour: data })
      }
    }

    const { data, error } = await fastify.supabase
      .rpc('get_tour_data', { p_slug: params.slug })

    if (error) throw error
    if (!data) return reply.code(404).send({ statusMessage: 'Tour not found' })

    // Cache tour data for 60s — invalidated on next publish/update via TTL
    if (fastify.redis && data) {
      void fastify.redis.setEx(cacheKey, 60, JSON.stringify(data)).catch(() => {})
    }

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

    reply.header('X-Cache', 'MISS')
    return reply.send({ tour: data })
  })
}
