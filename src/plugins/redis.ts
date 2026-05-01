import fp from 'fastify-plugin'
import { createClient } from 'redis'
import type { FastifyInstance } from 'fastify'

type RedisClient = ReturnType<typeof createClient>

declare module 'fastify' {
  interface FastifyInstance {
    redis: RedisClient | null
  }
}

export default fp(async (fastify: FastifyInstance) => {
  if (!process.env.REDIS_URL) {
    fastify.decorate('redis', null)
    return
  }

  const client = createClient({ url: process.env.REDIS_URL })
  client.on('error', (err) => fastify.log.warn({ err }, 'Redis client error'))

  // Connect in the background — don't block Fastify startup.
  // If Redis is briefly unavailable, the server degrades gracefully
  // (cache misses, no distributed rate-limiting) rather than crashing.
  // We decorate immediately so route handlers can do null checks safely.
  fastify.decorate('redis', client)

  client.connect().then(() => {
    fastify.log.info('Redis connected')
  }).catch((err) => {
    fastify.log.warn({ err }, 'Redis initial connect failed — running without cache')
    // Null out the decorator so routes fall back to no-cache paths
    ;(fastify as any).redis = null
  })

  fastify.addHook('onClose', async () => {
    if (client.isOpen) await client.quit().catch(() => {})
  })
})
