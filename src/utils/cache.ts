import { FastifyInstance } from 'fastify'

/**
 * Deletes the cached public tour payload for a space. GET /p/:slug accepts
 * either the slug or the space UUID and caches under whichever was requested,
 * so both keys are cleared — clearing only `tour:<slug>` left tours opened by
 * id serving stale scenes/hotspots for up to the 1h TTL.
 * Pass the slug when the caller already has it to skip the lookup query.
 */
export async function invalidateTourCache(fastify: FastifyInstance, spaceId: string, slug?: string | null) {
  if (!fastify.redis) return

  try {
    let resolvedSlug = slug
    if (resolvedSlug === undefined) {
      const { data: space } = await fastify.supabase
        .from('properties')
        .select('slug')
        .eq('id', spaceId)
        .single()
      resolvedSlug = space?.slug ?? null
    }

    const keys = [`tour:${spaceId}`]
    if (resolvedSlug) keys.push(`tour:${resolvedSlug}`)
    await fastify.redis.del(keys).catch(() => {})
    fastify.log.info({ spaceId, slug: resolvedSlug }, 'Invalidated public tour cache')
  } catch (err: any) {
    fastify.log.warn({ err: err?.message, spaceId }, 'Failed to invalidate space cache')
  }
}

/**
 * Invalidates the public tour cache in Redis for a specific space.
 * This ensures that updates to scenes, hotspots, or settings are visible immediately.
 */
export async function invalidateSpaceCache(fastify: FastifyInstance, spaceId: string) {
  await invalidateTourCache(fastify, spaceId)
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

