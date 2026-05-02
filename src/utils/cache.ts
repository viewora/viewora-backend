import { FastifyInstance } from 'fastify'

/**
 * Invalidates the public tour cache in Redis for a specific space.
 * This ensures that updates to scenes, hotspots, or settings are visible immediately.
 */
export async function invalidateSpaceCache(fastify: FastifyInstance, spaceId: string) {
  if (!fastify.redis) return

  try {
    // 1. Fetch the slug for this space
    const { data: space } = await fastify.supabase
      .from('properties')
      .select('slug')
      .eq('id', spaceId)
      .single()

    if (space?.slug) {
      const cacheKey = `tour:${space.slug}`
      await fastify.redis.del(cacheKey).catch(() => {})
      fastify.log.info({ spaceId, slug: space.slug }, 'Invalidated public tour cache')
    }
  } catch (err: any) {
    fastify.log.warn({ err: err?.message, spaceId }, 'Failed to invalidate space cache')
  }
}

/**
 * Invalidates the public tour cache by scene ID.
 * Finds the parent space first, then clears the cache.
 */
export async function invalidateCacheBySceneId(fastify: FastifyInstance, sceneId: string) {
  if (!fastify.redis) return

  try {
    const { data: scene } = await fastify.supabase
      .from('scenes')
      .select('space_id')
      .eq('id', sceneId)
      .single()

    if (scene?.space_id) {
      await invalidateSpaceCache(fastify, scene.space_id)
    }
  } catch (err: any) {
    fastify.log.warn({ err: err?.message, sceneId }, 'Failed to invalidate cache by scene ID')
  }
}
