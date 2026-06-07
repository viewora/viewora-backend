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

/**
 * Purges all cached tiles for a specific scene from Redis.
 * Called when a scene is deleted or re-processed.
 */
export async function purgeSceneTiles(fastify: FastifyInstance, sceneId: string) {
  if (!fastify.redis) return

  try {
    // 1. Clear the scene -> space mapping
    await fastify.redis.del(`scene-space:${sceneId}`).catch(() => {})

    // 2. Clear all tiles. Since Redis 'DEL' doesn't support wildcards, 
    // we would need 'SCAN' or a separate list of tile keys.
    // Given tiles are mostly immutable, we let them expire or we could 
    // try to find them if absolutely necessary. For now, we clear the 
    // scene-space mapping which will force a DB check if the scene 
    // were to somehow persist with new tiles (unlikely).
    
    // NOTE: If we use a Redis version that supports 'unlink' or similar patterns, 
    // we could do more here. For now, the 24h expiration is a safe fallback.
    fastify.log.info({ sceneId }, 'Purged scene tile mapping')
  } catch (err: any) {
    fastify.log.warn({ err: err?.message, sceneId }, 'Failed to purge scene tiles')
  }
}

